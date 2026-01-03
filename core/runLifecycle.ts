import type { Approval, StepApproval } from "./approvals";
import type { Router, RouterContext } from "./router";
import { legitimacyGate } from "./legitimacyGate";
import { planForIntent, type Plan } from "./planner";
import { createReceiptWriter } from "./receipts";
import { loadConfig } from "./config";
import { evidenceFromExternalRef, evidenceFromFileHash, evidenceFromPastedText, type Evidence } from "./evidence";
import { ApprovalRequiredError } from "./approvals";
import * as crypto from "crypto";
import { activateJudgment, appendProvenanceAudit, clearJudgment, ensureGenesisRecord, verifyProvenance } from "./provenance";

export type RunLifecycleResult = {
    ok: boolean;
    capability?: string;
    plan?: Plan;
    result?: unknown;
    refusal?: { code: string; reason: string };
    missingStepIds?: string[];
    warnings?: string[];
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
    // Optional: execute only a single step from the planned steps.
    executeStepId?: string;
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
        if (msg === "obsidian_judgment_active") return { code: "obsidian_judgment", reason: "obsidian_judgment_active" };
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

    // Provenance verification happens before any human-facing response.
    // If provenance fails, enter Obsidian's Judgment and restrict privileged execution.
    ensureGenesisRecord(args.ctx.repoRoot, { writeEnabled: loadConfig(args.ctx.repoRoot).writeEnabled });
    const prov = verifyProvenance(args.ctx.repoRoot);
    if (!prov.ok) {
        appendProvenanceAudit(args.ctx.repoRoot, { kind: "provenance.fail", data: prov });
        receipt?.appendEvent("provenance.fail", prov);
        activateJudgment(args.ctx.repoRoot, prov);

        // Allow read-only intents to continue; refuse privileged operations.
        // We do not attempt to explain here beyond the refusal/receipt.
        const plannedCapability = args.router.route({ raw: args.intent }) ?? undefined;
        if (plannedCapability) {
            try {
                // Import lazily to avoid cycles: classify via planner/meta when executing.
                // Router enforcement will block non-readOnly anyway.
                void plannedCapability;
            } catch {
                // ignore
            }
        }
    } else {
        // Provenance ok => clear any prior judgment marker.
        clearJudgment(args.ctx.repoRoot);
        receipt?.appendEvent("provenance.ok");
    }

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

    // Execute the plan steps. (Planner may emit N steps.)
    // If a legacy approval is provided, only map it for single-step execution.
    // This keeps the invariants: every executed step has an explicit StepApproval.
    const requestedStepId = typeof args.executeStepId === "string" ? args.executeStepId.trim() : "";
    const approvals: StepApproval[] = Array.isArray(args.stepApprovals) ? [...args.stepApprovals] : [];
    if (approvals.length === 0 && args.approval) {
        const fallbackStepId = (plan.steps[0]?.id ?? "").trim();
        const stepId = (requestedStepId || fallbackStepId).trim();

        const isSingleStepPlan = plan.steps.length === 1;
        const isSingleRequestedStep = Boolean(requestedStepId);
        const stepExists = stepId.length > 0 && plan.steps.some((s) => s.id === stepId);

        if (stepExists && (isSingleStepPlan || isSingleRequestedStep)) {
            approvals.push({ ...args.approval, stepId });
        }
    }
    const planStepIds = new Set(plan.steps.map((s) => s.id));
    const unknownApprovalStepIds = new Set<string>();
    const duplicateApprovalStepIds = new Set<string>();

    const byStepId = new Map<string, StepApproval>();
    for (const a of approvals) {
        if (!a || typeof a.stepId !== "string") continue;
        const sid = a.stepId.trim();
        if (!sid) continue;

        if (!planStepIds.has(sid)) {
            unknownApprovalStepIds.add(sid);
            continue;
        }

        if (byStepId.has(sid)) {
            duplicateApprovalStepIds.add(sid);
        }

        // Keep last-write-wins, but normalize stepId.
        byStepId.set(sid, { ...a, stepId: sid });
    }

    if (unknownApprovalStepIds.size > 0) {
        const unknown = Array.from(unknownApprovalStepIds).sort();
        receipt?.appendEvent("approval.unknown_step", { unknownStepIds: unknown, knownStepIds: Array.from(planStepIds).sort() });
        receipt?.writeJson("final.json", {
            ok: false,
            status: "REFUSED",
            stage: "approval",
            planId: (plan as any).planId,
            refusal: { code: "unknown_step_approval", reason: `Approval references unknown stepId(s): ${unknown.join(", ")}` }
        });
        const finalized = receipt?.finalize();
        return {
            ok: false,
            capability: plan.steps[0]?.tool?.name,
            plan,
            refusal: { code: "unknown_step_approval", reason: `Approval references unknown stepId(s): ${unknown.join(", ")}` },
            ...(finalized ? { receipt: finalized } : {})
        };
    }

    const warnings: string[] = [];
    if (duplicateApprovalStepIds.size > 0) {
        receipt?.appendEvent("approval.duplicate", { stepIds: Array.from(duplicateApprovalStepIds).sort(), policy: "last_write_wins" });
        warnings.push("duplicate_step_approval_last_write_wins");
    }

    const outputs: unknown[] = [];
    const stepIds = plan.steps.map((s) => s.id);
    const requestedIndex = requestedStepId ? stepIds.indexOf(requestedStepId) : -1;
    if (requestedStepId && requestedIndex < 0) {
        receipt?.appendEvent("refusal", { code: "unknown_step", stepId: requestedStepId, knownStepIds: stepIds });
        receipt?.writeJson("final.json", {
            ok: false,
            status: "REFUSED",
            stage: "execution",
            planId: (plan as any).planId,
            ...(warnings.length ? { warnings } : {}),
            refusal: { code: "unknown_step", reason: `Unknown stepId: ${requestedStepId}` }
        });
        const finalized = receipt?.finalize();
        return {
            ok: false,
            capability: plan.steps[0]?.tool?.name,
            plan,
            ...(warnings.length ? { warnings } : {}),
            refusal: { code: "unknown_step", reason: `Unknown stepId: ${requestedStepId}` },
            ...(finalized ? { receipt: finalized } : {})
        };
    }

    try {
        const start = requestedStepId ? requestedIndex : 0;
        const endExclusive = requestedStepId ? requestedIndex + 1 : plan.steps.length;

        for (let i = start; i < endExclusive; i++) {
            const step = plan.steps[i];
            const approval = byStepId.get(step.id);
            if (!approval) {
                const missingStepIds = (requestedStepId ? [step.id] : plan.steps.slice(i).map((s) => s.id));
                receipt?.appendEvent("approval.missing", { missingStepIds });
                receipt?.writeJson("outputs.json", { outputs });
                receipt?.writeJson("final.json", {
                    ok: false,
                    status: "REFUSED",
                    stage: "approval",
                    planId: (plan as any).planId,
                    missingStepIds,
                    ...(warnings.length ? { warnings } : {}),
                    refusal: { code: "step_approval_required", reason: "step approvals required" }
                });
                const finalized = receipt?.finalize();
                return {
                    ok: false,
                    capability: plan.steps[0]?.tool?.name,
                    plan,
                    missingStepIds,
                    ...(warnings.length ? { warnings } : {}),
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
        receipt?.writeJson("final.json", {
            ok: true,
            status: "OK",
            planId: (plan as any).planId,
            ...(warnings.length ? { warnings } : {}),
            steps: requestedStepId ? [requestedStepId] : plan.steps.map((s: any) => s.id)
        });
        const finalized = receipt?.finalize();
        return {
            ok: true,
            capability: plan.steps[0]?.tool?.name,
            plan,
            result: outputs,
            ...(warnings.length ? { warnings } : {}),
            ...(finalized ? { receipt: finalized } : {})
        };
    } catch (e) {
        const refusal = classifyRefusal(e);
        receipt?.appendEvent("step.error", { refusal });
        receipt?.writeJson("outputs.json", { outputs });
        receipt?.writeJson("final.json", {
            ok: false,
            status: "REFUSED",
            stage: "execution",
            planId: (plan as any).planId,
            ...(warnings.length ? { warnings } : {}),
            refusal
        });
        const finalized = receipt?.finalize();
        return {
            ok: false,
            capability: plan.steps[0]?.tool?.name,
            plan,
            ...(warnings.length ? { warnings } : {}),
            refusal,
            ...(finalized ? { receipt: finalized } : {})
        };
    }
}
