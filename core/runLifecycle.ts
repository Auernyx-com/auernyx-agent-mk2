import type { Approval, StepApproval } from "./approvals";
import type { Router, RouterContext } from "./router";
import { legitimacyGate } from "./legitimacyGate";
import { planForIntent, type Plan } from "./planner";
import { createReceiptWriter } from "./receipts";
import { loadConfig } from "./config";
import { evidenceFromExternalRef, evidenceFromFileHash, evidenceFromPastedText, type Evidence } from "./evidence";
import { ApprovalRequiredError } from "./approvals";
import * as crypto from "crypto";

export type RunLifecycleResult = {
    ok: boolean;
    capability?: string;
    plan?: Plan;
    result?: unknown;
    refusal?: { code: string; reason: string };
    missingStepIds?: string[];
    receipt?: { runId: string; dirPath: string };
};

export type EvidenceInput =
    | { type: "pasted_text"; text: string; notes?: string }
    | { type: "file_hash"; path: string; notes?: string }
    | { type: "external_ref"; ref: string; notes?: string };

export async function runLifecycle(args: {
    router: Router;
    ctx: RouterContext;
    intent: string;
    input?: unknown;
    // Legacy approval: used only for single-step plans (mapped to step-1).
    approval?: Approval;
    // Preferred path: per-step approvals.
    stepApprovals?: StepApproval[];
    evidence?: EvidenceInput[];
}): Promise<RunLifecycleResult> {
    // GOVERNANCE LAW (must remain true):
    // - Single execution path: all real execution flows through runLifecycle.
    // - Plan-based execution only: router will reject any unmarked execution.
    // - Step-scoped approvals: every executed step requires a StepApproval.
    // - Receipts are mandatory: success and refusal produce an end-to-end trail.
    const cfg = loadConfig(args.ctx.repoRoot);
    const receipt = createReceiptWriter(args.ctx.repoRoot, { receiptsEnabled: cfg.receiptsEnabled });

    const sha256Hex = (buf: Buffer | string) => crypto.createHash("sha256").update(buf).digest("hex");
    const stableStringify = (value: unknown): string => {
        const seen = new WeakSet<object>();
        const normalize = (v: any): any => {
            if (v === null || v === undefined) return v;
            const t = typeof v;
            if (t === "number" || t === "string" || t === "boolean") return v;
            if (Array.isArray(v)) return v.map(normalize);
            if (t === "object") {
                if (seen.has(v)) return "[Circular]";
                seen.add(v);
                const out: Record<string, any> = {};
                for (const k of Object.keys(v).sort()) out[k] = normalize(v[k]);
                return out;
            }
            return String(v);
        };
        return JSON.stringify(normalize(value));
    };

    const classifyRefusal = (err: unknown): { code: string; reason: string } => {
        if (err instanceof ApprovalRequiredError) {
            return { code: err.code, reason: "approval_required" };
        }
        const msg = err instanceof Error ? err.message : String(err);
        if (msg === "confirm_required") return { code: "confirm_required", reason: msg };
        if (msg === "no_authority") return { code: "no_authority", reason: msg };
        if (msg === "write_disabled") return { code: "write_disabled", reason: msg };
        if (msg === "direct_execution_disabled") return { code: "direct_execution_disabled", reason: msg };
        if (msg.startsWith("Policy blocked capability:")) return { code: "policy_denied", reason: msg };
        if (msg.startsWith("governance_locked:")) return { code: "governance_locked", reason: msg };
        return { code: "execution_error", reason: msg };
    };

    const intake = { intent: args.intent, input: args.input };
    receipt?.writeJson("intake.json", intake);
    receipt?.ensureEmptyFile("approvals.ndjson");
    receipt?.ensureEmptyFile("toolcalls.ndjson");

    const gate = legitimacyGate(args.intent);
    if (!gate.ok) {
        receipt?.writeJson("legitimacy.json", gate);
        receipt?.appendEvent("refusal", gate);
        receipt?.writeJson("final.json", { ok: false, status: "REFUSED", stage: "legitimacy", refusal: gate });
        const finalized = receipt?.finalize();
        return {
            ok: false,
            refusal: { code: gate.code, reason: gate.reason },
            ...(finalized ? { receipt: finalized } : {})
        };
    }

    receipt?.writeJson("legitimacy.json", gate);

    let plan: Plan;
    try {
        plan = planForIntent(args.router, args.intent, args.input);
    } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        receipt?.appendEvent("unroutable", { intent: args.intent, error: reason });
        receipt?.writeJson("final.json", { ok: false, status: "REFUSED", stage: "planning", refusal: { code: "unroutable_intent", reason } });
        const finalized = receipt?.finalize();
        return {
            ok: false,
            refusal: { code: "unroutable_intent", reason },
            ...(finalized ? { receipt: finalized } : {})
        };
    }

    receipt?.writeJson("plan.json", plan);

    const evidenceOut: Evidence[] = [];
    if (receipt && Array.isArray(args.evidence) && args.evidence.length > 0) {
        for (const ev of args.evidence) {
            try {
                if (ev.type === "pasted_text") {
                    const evi = evidenceFromPastedText(String(ev.text ?? ""), ev.notes);
                    evidenceOut.push(evi);
                    receipt.writeText(`evidence/${evi.id}.txt`, String(ev.text ?? ""));
                    receipt.writeJson(`evidence/${evi.id}.json`, evi);
                } else if (ev.type === "file_hash") {
                    const evi = evidenceFromFileHash(String(ev.path ?? ""), ev.notes);
                    evidenceOut.push(evi);
                    receipt.writeJson(`evidence/${evi.id}.json`, evi);
                } else if (ev.type === "external_ref") {
                    const evi = evidenceFromExternalRef(String(ev.ref ?? ""), ev.notes);
                    evidenceOut.push(evi);
                    receipt.writeJson(`evidence/${evi.id}.json`, evi);
                }
            } catch (e) {
                receipt.appendEvent("evidence.error", { error: e instanceof Error ? e.message : String(e) });
            }
        }
    }

    // Execute the plan steps. (Currently planner emits 1 step; this supports N.)
    const approvals = Array.isArray(args.stepApprovals) ? args.stepApprovals : [];
    const byStepId = new Map<string, StepApproval>();
    for (const a of approvals) {
        if (a && typeof a.stepId === "string") byStepId.set(a.stepId, a);
    }

    const outputs: unknown[] = [];

    try {
        for (let i = 0; i < plan.steps.length; i++) {
            const step = plan.steps[i];
            const approval = byStepId.get(step.id);
            if (!approval) {
                const missingStepIds = plan.steps.slice(i).map((s) => s.id);
                receipt?.appendEvent("approval.missing", { missingStepIds });
                receipt?.writeJson("outputs.json", { outputs });
                receipt?.writeJson("final.json", {
                    ok: false,
                    status: "REFUSED",
                    stage: "approval",
                    planId: (plan as any).planId,
                    missingStepIds,
                    refusal: { code: "step_approval_required", reason: "step approvals required" }
                });
                const finalized = receipt?.finalize();
                return {
                    ok: false,
                    capability: plan.steps[0]?.tool?.name,
                    plan,
                    missingStepIds,
                    refusal: { code: "step_approval_required", reason: "step approvals required" },
                    ...(finalized ? { receipt: finalized } : {})
                };
            }

            const approvalHash = sha256Hex(stableStringify(approval));
            receipt?.appendNdjson("approvals.ndjson", { ...approval, approvalHash });
            receipt?.appendNdjson("toolcalls.ndjson", { ts: new Date().toISOString(), stepId: step.id, tool: step.tool, input: step.input });
            receipt?.appendEvent("step.start", { id: step.id, tool: step.tool });

            const ctx: RouterContext = {
                ...args.ctx,
                execution: { planId: (plan as any).planId, stepId: step.id }
            };

            const out = await args.router.executeStep(step as any, ctx, approval);
            outputs.push({ stepId: step.id, tool: step.tool, output: out });
            receipt?.appendEvent("step.ok", { id: step.id, tool: step.tool });
        }

        receipt?.writeJson("outputs.json", { outputs });
        receipt?.writeJson("final.json", { ok: true, planId: (plan as any).planId, steps: plan.steps.map((s: any) => s.id) });
        const finalized = receipt?.finalize();
        return {
            ok: true,
            capability: plan.steps[0]?.tool?.name,
            plan,
            result: outputs,
            ...(finalized ? { receipt: finalized } : {})
        };
    } catch (e) {
        const refusal = classifyRefusal(e);
        receipt?.appendEvent("step.error", { refusal });
        receipt?.writeJson("outputs.json", { outputs });
        receipt?.writeJson("final.json", { ok: false, status: "REFUSED", stage: "execution", planId: (plan as any).planId, refusal });
        const finalized = receipt?.finalize();
        return {
            ok: false,
            capability: plan.steps[0]?.tool?.name,
            plan,
            refusal,
            ...(finalized ? { receipt: finalized } : {})
        };
    }
}
