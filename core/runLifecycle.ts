import type { Approval, StepApproval } from "./approvals";
import type { Router, RouterContext } from "./router";
import { legitimacyGate } from "./legitimacyGate";
import { planForIntent, type Plan } from "./planner";
import { createReceiptWriter } from "./receipts";
import { loadConfig } from "./config";
import { evidenceFromExternalRef, evidenceFromFileHash, evidenceFromPastedText, type Evidence } from "./evidence";
import { ApprovalRequiredError } from "./approvals";
import { activateJudgment, appendProvenanceAudit, clearJudgment, ensureGenesisRecord, verifyProvenance } from "./provenance";
import { sha256Hex, stableStringify } from "./crypto";
import { gitStatusPorcelain, isDirtyPorcelain } from "./git";
import { canonGitignoreStatus, computePlanHash, computePseudoDiff, loadVsCodePolicy } from "./vscodePolicy";
import { GovernanceRefusalError } from "./governanceRefusal";
import { getApproverIdentity } from "./kintsugi/memory";

type DecisionCode = "OK_PREVIEW_ONLY" | "OK_APPLIED";
type RefusalCode =
    | "REFUSE_WRITE_GATE_MISSING"
    | "REFUSE_PROTECTED_PATH"
    | "REFUSE_CANON_NOT_IGNORED"
    | "REFUSE_AUDIT_WEAKENING"
    | "REFUSE_AMBIGUOUS_REQUEST";


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
    const vscodePolicy = loadVsCodePolicy(args.ctx.repoRoot);

    // Receipts are always-on for audit cleanliness.
    const receipt = createReceiptWriter(args.ctx.repoRoot, { receiptsEnabled: true });


    const classifyToCanonicalRefusal = (err: unknown): { code: RefusalCode; message: string; protectedPathViolation: boolean } => {
        // Protected path violations must be hard-coded to the canonical refusal code.
        if (err instanceof GovernanceRefusalError) {
            const msg = `${err.refusal.refusalReason}: ${err.refusal.notes ?? "protected path"}`;
            return { code: "REFUSE_PROTECTED_PATH", message: msg, protectedPathViolation: true };
        }

        if (err instanceof ApprovalRequiredError) {
            // Approval missing is treated as "not armed" => preview-only in this governance model.
            return { code: "REFUSE_WRITE_GATE_MISSING", message: "approval_required", protectedPathViolation: false };
        }

        const msg = err instanceof Error ? err.message : String(err);

        // Mapping rules (hard, deterministic)
        if (msg === "apply_flag_required" || msg === "confirm_required" || msg === "write_disabled") {
            return { code: "REFUSE_WRITE_GATE_MISSING", message: msg, protectedPathViolation: false };
        }

        if (msg === "canon_not_gitignored") {
            return { code: "REFUSE_CANON_NOT_IGNORED", message: msg, protectedPathViolation: false };
        }

        if (msg === "preflight_git_dirty" || msg === "preflight_git_unavailable") {
            // Keep code stable; put specifics in message/evidence.
            return { code: "REFUSE_WRITE_GATE_MISSING", message: msg, protectedPathViolation: false };
        }

        // Intent is ambiguous enough to risk side effects.
        if (msg === "ambiguous_side_effect_request") {
            return { code: "REFUSE_AMBIGUOUS_REQUEST", message: msg, protectedPathViolation: false };
        }

        if (msg === "risk_tolerance_insufficient") {
            return { code: "REFUSE_WRITE_GATE_MISSING", message: msg, protectedPathViolation: false };
        }

        // Default catch-all: anything else is expressed as audit-weakening (cannot safely proceed).
        return { code: "REFUSE_AUDIT_WEAKENING", message: msg, protectedPathViolation: false };
    };

    const now = new Date();
    const timestampUtc = now.toISOString();
    const timestampLocal = now.toString();

    const captureGit = (name: "pre" | "post") => {
        const st = gitStatusPorcelain(args.ctx.repoRoot);
        if (receipt) {
            receipt.writeJson(`git/status.${name}.json`, st);
            receipt.writeText(`git/status.${name}.porcelain.txt`, st.ok ? (st.porcelain ?? "") : `ERROR: ${st.error ?? "git_error"}`);
        }
        return st;
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

    const gitPre = vscodePolicy.git_rules.capture_status_porcelain_pre ? captureGit("pre") : { ok: false, error: "git_capture_disabled" };

    const gate = legitimacyGate(args.intent);
    if (!gate.ok) {
        const canon = canonGitignoreStatus(args.ctx.repoRoot);
        const gitPost = vscodePolicy.git_rules.capture_status_porcelain_post ? captureGit("post") : { ok: false, error: "git_capture_disabled" };

        const refusal = { code: "REFUSE_AMBIGUOUS_REQUEST" as const, message: `illegitimate_request:${gate.reason}` };
        receipt?.writeJson("legitimacy.json", gate);
        receipt?.appendEvent("refusal", refusal);
        receipt?.writeJson("governance.json", {
            decision_code: refusal.code,
            write_gate: { env: cfg.writeEnabled, armed: false },
            git_porcelain_pre: gitPre.ok ? (gitPre.porcelain ?? "") : "",
            git_porcelain_post: gitPost.ok ? (gitPost.porcelain ?? "") : "",
            canon_gitignore_ok: canon.ok,
            protected_path_violation: false,
            plan_hash_sha256: "",
            diff_hash_sha256: "",
            receipt_hash_sha256: sha256Hex(`REFUSED:${refusal.code}:${refusal.message}`),
            message: refusal.message,
            timestamp_local: timestampLocal,
            timestamp_utc: timestampUtc,
            repo_root: args.ctx.repoRoot,
            invocation: intake,
        });
        receipt?.writeJson("final.json", { ok: false, status: "REFUSED", stage: "legitimacy", refusal: { code: refusal.code, reason: refusal.message } });
        const finalized = receipt?.finalize();
        return {
            ok: false,
            refusal: { code: refusal.code, reason: refusal.message },
            ...(finalized ? { receipt: finalized } : {})
        };
    }

    receipt?.writeJson("legitimacy.json", gate);

    let plan: Plan;
    try {
        plan = planForIntent(args.router, args.intent, args.input);
    } catch (e) {
        const canon = canonGitignoreStatus(args.ctx.repoRoot);
        const gitPost = vscodePolicy.git_rules.capture_status_porcelain_post ? captureGit("post") : { ok: false, error: "git_capture_disabled" };
        const msg = e instanceof Error ? e.message : String(e);
        const refusal = { code: "REFUSE_AMBIGUOUS_REQUEST" as const, message: `unroutable_intent:${msg}` };
        receipt?.appendEvent("unroutable", { intent: args.intent, error: msg });
        receipt?.writeJson("governance.json", {
            decision_code: refusal.code,
            write_gate: { env: cfg.writeEnabled, armed: false },
            git_porcelain_pre: gitPre.ok ? (gitPre.porcelain ?? "") : "",
            git_porcelain_post: gitPost.ok ? (gitPost.porcelain ?? "") : "",
            canon_gitignore_ok: canon.ok,
            protected_path_violation: false,
            plan_hash_sha256: "",
            diff_hash_sha256: "",
            receipt_hash_sha256: sha256Hex(`REFUSED:${refusal.code}:${refusal.message}`),
            message: refusal.message,
            timestamp_local: timestampLocal,
            timestamp_utc: timestampUtc,
            repo_root: args.ctx.repoRoot,
            invocation: intake,
        });
        receipt?.writeJson("final.json", { ok: false, status: "REFUSED", stage: "planning", refusal: { code: refusal.code, reason: refusal.message } });
        const finalized = receipt?.finalize();
        return {
            ok: false,
            refusal: { code: refusal.code, reason: refusal.message },
            ...(finalized ? { receipt: finalized } : {})
        };
    }

    receipt?.writeJson("plan.json", plan);

    const plannedCapability = plan.steps[0]?.tool?.name;
    const proposedFiles: string[] = (() => {
        switch (plannedCapability) {
            case "searchDocApply":
            case "searchDocPreview":
                return ["docs/SEARCH.md"];
            case "fenerisPrep":
                return ["feneris-windows/init.ps1"];
            case "baselinePre":
                return [
                    "artifacts/known_good/entries/*.kgs.json",
                    "artifacts/known_good/snapshots/<KGS_ID>/*",
                    ".auernyx/kintsugi/policy/history/*.policy.json",
                    ".auernyx/kintsugi/policy/active.policy.json",
                    ".auernyx/kintsugi/known_good/entries/*.kgs.json"
                ];
            case "baselinePost":
                return [];
            case "proposeFixes":
                return [".auernyx/kintsugi/policy/history/*.policy.json", ".auernyx/kintsugi/policy/active.policy.json"];
            case "governanceSelfTest":
            case "governanceUnlock":
                return ["logs/governance.lock.json"];
            case "rollbackKnownGood":
                return [".auernyx/kintsugi/policy/history/*.policy.json", ".auernyx/kintsugi/policy/active.policy.json"];
            default:
                return [];
        }
    })();

    const diffPreview = computePseudoDiff({ capability: plannedCapability as any, proposedFiles });
    const planHashSha256 = computePlanHash(plan);
    receipt?.writeText("diff.preview.txt", diffPreview.text);
    receipt?.writeJson("preview.json", {
        timestamp_local: timestampLocal,
        timestamp_utc: timestampUtc,
        repo_root: args.ctx.repoRoot,
        invocation: { intent: args.intent, input: args.input, executeStepId: args.executeStepId ?? null },
        proposed_files: proposedFiles,
        plan_hash_sha256: planHashSha256,
        diff_hash_sha256: diffPreview.sha256,
        plan_risk_class: plan.riskClass,
        rollback_points: plan.rollbackPoints,
    });

    // Ambiguity hard-stop for mutating intents that are too vague.
    const intentText = String(args.intent ?? "").trim().toLowerCase();
    const looksVague = /^(fix(\s+it)?|clean(\s+up)?|make\s+it\s+work|do\s+it|handle\s+it)\b/.test(intentText);
    const plannedIsMutating = plan.steps.some((s) => String(s.type).toUpperCase() !== "READ_ONLY");
    if (plannedIsMutating && looksVague) {
        const canon = canonGitignoreStatus(args.ctx.repoRoot);
        const gitPost = vscodePolicy.git_rules.capture_status_porcelain_post ? captureGit("post") : { ok: false, error: "git_capture_disabled" };
        const refusal: { code: RefusalCode; message: string; protectedPathViolation: boolean } = {
            code: "REFUSE_AMBIGUOUS_REQUEST",
            message: "ambiguous_side_effect_request",
            protectedPathViolation: false
        };
        receipt?.appendEvent("refusal", refusal);
        receipt?.writeJson("governance.json", {
            decision_code: refusal.code,
            write_gate: { env: cfg.writeEnabled, armed: false },
            git_porcelain_pre: gitPre.ok ? (gitPre.porcelain ?? "") : "",
            git_porcelain_post: gitPost.ok ? (gitPost.porcelain ?? "") : "",
            canon_gitignore_ok: canon.ok,
            protected_path_violation: false,
            plan_hash_sha256: planHashSha256,
            diff_hash_sha256: diffPreview.sha256,
            receipt_hash_sha256: sha256Hex(`REFUSED:${refusal.code}:${refusal.message}:${planHashSha256}:${diffPreview.sha256}`),
            message: refusal.message,
            timestamp_local: timestampLocal,
            timestamp_utc: timestampUtc,
            repo_root: args.ctx.repoRoot,
            invocation: intake,
        });
        receipt?.writeJson("final.json", { ok: false, status: "REFUSED", stage: "preflight", refusal: { code: refusal.code, reason: refusal.message } });
        const finalized = receipt?.finalize();
        return {
            ok: false,
            capability: plannedCapability,
            plan,
            refusal: { code: refusal.code, reason: refusal.message },
            ...(finalized ? { receipt: finalized } : {})
        };
    }

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
        const gitPost = vscodePolicy.git_rules.capture_status_porcelain_post ? captureGit("post") : { ok: false, error: "git_capture_disabled" };
        const canon = canonGitignoreStatus(args.ctx.repoRoot);
        const refusal: { code: RefusalCode; message: string; protectedPathViolation: boolean } = {
            code: "REFUSE_AMBIGUOUS_REQUEST",
            message: `unknown_step_approval:${unknown.join(",")}`,
            protectedPathViolation: false
        };
        receipt?.writeJson("final.json", {
            ok: false,
            status: "REFUSED",
            stage: "approval",
            planId: plan.planId,
            refusal: { code: refusal.code, reason: refusal.message }
        });
        receipt?.writeJson("governance.json", {
            decision_code: refusal.code,
            write_gate: { env: cfg.writeEnabled, armed: false },
            git_porcelain_pre: gitPre.ok ? (gitPre.porcelain ?? "") : "",
            git_porcelain_post: gitPost.ok ? (gitPost.porcelain ?? "") : "",
            canon_gitignore_ok: canon.ok,
            protected_path_violation: false,
            plan_hash_sha256: planHashSha256,
            diff_hash_sha256: diffPreview.sha256,
            receipt_hash_sha256: sha256Hex(`REFUSED:${refusal.code}:${planHashSha256}:${diffPreview.sha256}:${refusal.message}`),
            message: refusal.message,
            timestamp_local: timestampLocal,
            timestamp_utc: timestampUtc,
            repo_root: args.ctx.repoRoot,
            invocation: intake,
        });
        const finalized = receipt?.finalize();
        return {
            ok: false,
            capability: plan.steps[0]?.tool?.name,
            plan,
            refusal: { code: refusal.code, reason: refusal.message },
            ...(finalized ? { receipt: finalized } : {})
        };
    }

    const warnings: string[] = [];
    if (duplicateApprovalStepIds.size > 0) {
        receipt?.appendEvent("approval.duplicate", { stepIds: Array.from(duplicateApprovalStepIds).sort(), policy: "last_write_wins" });
        warnings.push("duplicate_step_approval_last_write_wins");
    }

    const approverIdentity = getApproverIdentity(args.ctx.repoRoot);
    const outputs: unknown[] = [];
    const stepIds = plan.steps.map((s) => s.id);
    const requestedIndex = requestedStepId ? stepIds.indexOf(requestedStepId) : -1;
    if (requestedStepId && requestedIndex < 0) {
        receipt?.appendEvent("refusal", { code: "unknown_step", stepId: requestedStepId, knownStepIds: stepIds });
        const gitPost = vscodePolicy.git_rules.capture_status_porcelain_post ? captureGit("post") : { ok: false, error: "git_capture_disabled" };
        const canon = canonGitignoreStatus(args.ctx.repoRoot);
        const refusal: { code: RefusalCode; message: string; protectedPathViolation: boolean } = {
            code: "REFUSE_AMBIGUOUS_REQUEST",
            message: `unknown_step:${requestedStepId}`,
            protectedPathViolation: false
        };
        receipt?.writeJson("final.json", {
            ok: false,
            status: "REFUSED",
            stage: "execution",
            planId: plan.planId,
            ...(warnings.length ? { warnings } : {}),
            refusal: { code: refusal.code, reason: refusal.message }
        });
        receipt?.writeJson("governance.json", {
            decision_code: refusal.code,
            write_gate: { env: cfg.writeEnabled, armed: false },
            git_porcelain_pre: gitPre.ok ? (gitPre.porcelain ?? "") : "",
            git_porcelain_post: gitPost.ok ? (gitPost.porcelain ?? "") : "",
            canon_gitignore_ok: canon.ok,
            protected_path_violation: false,
            plan_hash_sha256: planHashSha256,
            diff_hash_sha256: diffPreview.sha256,
            receipt_hash_sha256: sha256Hex(`REFUSED:${refusal.code}:${planHashSha256}:${diffPreview.sha256}:${refusal.message}`),
            message: refusal.message,
            timestamp_local: timestampLocal,
            timestamp_utc: timestampUtc,
            repo_root: args.ctx.repoRoot,
            invocation: intake,
        });
        const finalized = receipt?.finalize();
        return {
            ok: false,
            capability: plan.steps[0]?.tool?.name,
            plan,
            ...(warnings.length ? { warnings } : {}),
            refusal: { code: refusal.code, reason: refusal.message },
            ...(finalized ? { receipt: finalized } : {})
        };
    }

    // PREVIEW-ONLY short-circuit: if the plan includes any non-readonly steps but is not armed, do not execute.
    // This must still emit receipts and return OK_PREVIEW_ONLY.
    const firstApproval = byStepId.get(plan.steps[0]?.id ?? "");
    const armed = (firstApproval as any)?.apply === true;
    const canon = canonGitignoreStatus(args.ctx.repoRoot);

    if (plannedIsMutating && !armed) {
        const gitPost = vscodePolicy.git_rules.capture_status_porcelain_post ? captureGit("post") : { ok: false, error: "git_capture_disabled" };
        const decision: DecisionCode = "OK_PREVIEW_ONLY";
        receipt?.appendEvent("preview_only", { reason: "not_armed" });
        receipt?.writeJson("outputs.json", {
            outputs: [
                {
                    stepId: plan.steps[0]?.id ?? "step-1",
                    tool: plan.steps[0]?.tool,
                    output: {
                        mode: "preview",
                        decision_code: decision,
                        proposed_files: proposedFiles,
                        plan_hash_sha256: planHashSha256,
                        diff_hash_sha256: diffPreview.sha256,
                    }
                }
            ]
        });
        receipt?.writeJson("governance.json", {
            decision_code: decision,
            write_gate: { env: cfg.writeEnabled, armed: false },
            git_porcelain_pre: gitPre.ok ? (gitPre.porcelain ?? "") : "",
            git_porcelain_post: gitPost.ok ? (gitPost.porcelain ?? "") : "",
            canon_gitignore_ok: canon.ok,
            protected_path_violation: false,
            plan_hash_sha256: planHashSha256,
            diff_hash_sha256: diffPreview.sha256,
            receipt_hash_sha256: sha256Hex(`OK:${decision}:${planHashSha256}:${diffPreview.sha256}`),
            message: "preview_only_not_armed",
            timestamp_local: timestampLocal,
            timestamp_utc: timestampUtc,
            repo_root: args.ctx.repoRoot,
            invocation: intake,
        });
        receipt?.writeJson("final.json", {
            ok: true,
            status: "OK",
            decision_code: decision,
            planId: plan.planId,
            steps: []
        });
        const finalized = receipt?.finalize();
        return {
            ok: true,
            capability: plannedCapability,
            plan,
            result: [],
            ...(finalized ? { receipt: finalized } : {}),
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
                const gitPost = vscodePolicy.git_rules.capture_status_porcelain_post ? captureGit("post") : { ok: false, error: "git_capture_disabled" };
                const canon = canonGitignoreStatus(args.ctx.repoRoot);
                const refusal: { code: RefusalCode; message: string; protectedPathViolation: boolean } = {
                    code: "REFUSE_WRITE_GATE_MISSING",
                    message: `step_approval_required:${missingStepIds.join(",")}`,
                    protectedPathViolation: false
                };
                receipt?.writeJson("final.json", {
                    ok: false,
                    status: "REFUSED",
                    stage: "approval",
                    planId: plan.planId,
                    missingStepIds,
                    ...(warnings.length ? { warnings } : {}),
                    refusal: { code: refusal.code, reason: refusal.message }
                });
                receipt?.writeJson("governance.json", {
                    decision_code: refusal.code,
                    write_gate: { env: cfg.writeEnabled, armed: false },
                    git_porcelain_pre: gitPre.ok ? (gitPre.porcelain ?? "") : "",
                    git_porcelain_post: gitPost.ok ? (gitPost.porcelain ?? "") : "",
                    canon_gitignore_ok: canon.ok,
                    protected_path_violation: false,
                    plan_hash_sha256: planHashSha256,
                    diff_hash_sha256: diffPreview.sha256,
                    receipt_hash_sha256: sha256Hex(`REFUSED:${refusal.code}:${planHashSha256}:${diffPreview.sha256}:${refusal.message}`),
                    message: refusal.message,
                    timestamp_local: timestampLocal,
                    timestamp_utc: timestampUtc,
                    repo_root: args.ctx.repoRoot,
                    invocation: intake,
                });
                const finalized = receipt?.finalize();
                return {
                    ok: false,
                    capability: plan.steps[0]?.tool?.name,
                    plan,
                    missingStepIds,
                    ...(warnings.length ? { warnings } : {}),
                    refusal: { code: refusal.code, reason: refusal.message },
                    ...(finalized ? { receipt: finalized } : {})
                };
            }

            // Evidence validation: every declared requirement on this step must be satisfied
            // before execution is allowed. user_assertion is satisfied by the step approval
            // carrying a known approver identity — the HIL's identity in the system IS the
            // assertion. All other types require a matching collected evidence item.
            const missingEvidenceIds: string[] = [];
            for (const req of step.requiredEvidence) {
                if (req.type === "user_assertion") {
                    if (!approverIdentity.trim()) {
                        missingEvidenceIds.push(`${req.id}:user_assertion:no_approver_identity`);
                    }
                } else {
                    if (!evidenceOut.some((ev) => ev.type === req.type)) {
                        missingEvidenceIds.push(`${req.id}:${req.type}:not_provided`);
                    }
                }
            }
            if (missingEvidenceIds.length > 0) {
                receipt?.appendEvent("evidence.missing", { stepId: step.id, missingEvidenceIds });
                receipt?.writeJson("outputs.json", { outputs });
                const gitPost = vscodePolicy.git_rules.capture_status_porcelain_post ? captureGit("post") : { ok: false, error: "git_capture_disabled" };
                const canonPost = canonGitignoreStatus(args.ctx.repoRoot);
                const refusal: { code: RefusalCode; message: string; protectedPathViolation: boolean } = {
                    code: "REFUSE_WRITE_GATE_MISSING",
                    message: `step_evidence_required:${step.id}:${missingEvidenceIds.join(",")}`,
                    protectedPathViolation: false
                };
                receipt?.writeJson("final.json", {
                    ok: false,
                    status: "REFUSED",
                    stage: "evidence",
                    planId: plan.planId,
                    stepId: step.id,
                    missingEvidenceIds,
                    ...(warnings.length ? { warnings } : {}),
                    refusal: { code: refusal.code, reason: refusal.message }
                });
                receipt?.writeJson("governance.json", {
                    decision_code: refusal.code,
                    write_gate: { env: cfg.writeEnabled, armed },
                    git_porcelain_pre: gitPre.ok ? (gitPre.porcelain ?? "") : "",
                    git_porcelain_post: gitPost.ok ? (gitPost.porcelain ?? "") : "",
                    canon_gitignore_ok: canonPost.ok,
                    protected_path_violation: false,
                    plan_hash_sha256: planHashSha256,
                    diff_hash_sha256: diffPreview.sha256,
                    receipt_hash_sha256: sha256Hex(`REFUSED:${refusal.code}:${planHashSha256}:${diffPreview.sha256}:${refusal.message}`),
                    message: refusal.message,
                    timestamp_local: timestampLocal,
                    timestamp_utc: timestampUtc,
                    repo_root: args.ctx.repoRoot,
                    invocation: intake,
                });
                const finalized = receipt?.finalize();
                return {
                    ok: false,
                    capability: plan.steps[0]?.tool?.name,
                    plan,
                    ...(warnings.length ? { warnings } : {}),
                    refusal: { code: refusal.code, reason: refusal.message },
                    ...(finalized ? { receipt: finalized } : {})
                };
            }

            // Additional preconditions for APPLY (beyond router checks):
            // - git reachable
            // - dirty tree allowed only if explicitly requested
            // - canon paths must be gitignored
            const isMutatingStep = String(step.type).toUpperCase() !== "READ_ONLY";
            const applyArmed = (approval as any)?.apply === true;
            const allowDirty = (approval as any)?.allowDirty === true;

            if (isMutatingStep && applyArmed) {
                if (vscodePolicy.git_rules.require_repo_root_detection && !gitPre.ok) {
                    throw new Error("preflight_git_unavailable");
                }
                if (isDirtyPorcelain(gitPre.ok ? gitPre.porcelain : "") && !allowDirty) {
                    throw new Error("preflight_git_dirty");
                }
                if (vscodePolicy.canon_rules.must_be_gitignored && !canon.ok) {
                    throw new Error("canon_not_gitignored");
                }
            }

            const approvalHash = sha256Hex(stableStringify(approval));
            receipt?.appendNdjson("approvals.ndjson", { ...approval, approvalHash });
            receipt?.appendNdjson("toolcalls.ndjson", { ts: new Date().toISOString(), stepId: step.id, tool: step.tool, input: step.input });
            receipt?.appendEvent("step.start", { id: step.id, tool: step.tool });

            const ctx: RouterContext = {
                ...args.ctx,
                execution: { planId: plan.planId, stepId: step.id }
            };

            const out = await args.router.executeStep(step as any, ctx, approval);
            outputs.push({ stepId: step.id, tool: step.tool, output: out });
            receipt?.appendEvent("step.ok", { id: step.id, tool: step.tool });
        }

        const gitPost = vscodePolicy.git_rules.capture_status_porcelain_post ? captureGit("post") : { ok: false, error: "git_capture_disabled" };
        const changedFiles = (gitPost.ok ? (gitPost.porcelain ?? "") : "")
            .split("\n")
            .map((l) => l.trimEnd())
            .filter(Boolean)
            .map((l) => l.slice(3).trim())
            .filter(Boolean);

        const decision: DecisionCode = plan.steps.some((s) => String(s.type).toUpperCase() !== "READ_ONLY") ? "OK_APPLIED" : "OK_PREVIEW_ONLY";
        receipt?.writeJson("governance.json", {
            decision_code: decision,
            write_gate: { env: cfg.writeEnabled, armed: true },
            git_porcelain_pre: gitPre.ok ? (gitPre.porcelain ?? "") : "",
            git_porcelain_post: gitPost.ok ? (gitPost.porcelain ?? "") : "",
            canon_gitignore_ok: canon.ok,
            protected_path_violation: false,
            plan_hash_sha256: planHashSha256,
            diff_hash_sha256: diffPreview.sha256,
            receipt_hash_sha256: sha256Hex(`OK:${decision}:${planHashSha256}:${diffPreview.sha256}:${changedFiles.join("|")}`),
            message: vscodePolicy.closeout_reminder.enabled ? vscodePolicy.closeout_reminder.message : "",
            timestamp_local: timestampLocal,
            timestamp_utc: timestampUtc,
            repo_root: args.ctx.repoRoot,
            invocation: intake,
        });

        receipt?.writeJson("outputs.json", { outputs });
        receipt?.writeJson("final.json", {
            ok: true,
            status: "OK",
            decision_code: decision,
            planId: plan.planId,
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
        const refusal = classifyToCanonicalRefusal(e);
        receipt?.appendEvent("step.error", { refusal });
        receipt?.writeJson("outputs.json", { outputs });

        const gitPost = vscodePolicy.git_rules.capture_status_porcelain_post ? captureGit("post") : { ok: false, error: "git_capture_disabled" };
        receipt?.writeJson("governance.json", {
            decision_code: refusal.code,
            write_gate: { env: cfg.writeEnabled, armed: armed },
            git_porcelain_pre: gitPre.ok ? (gitPre.porcelain ?? "") : "",
            git_porcelain_post: gitPost.ok ? (gitPost.porcelain ?? "") : "",
            canon_gitignore_ok: canon.ok,
            protected_path_violation: refusal.protectedPathViolation,
            plan_hash_sha256: planHashSha256,
            diff_hash_sha256: diffPreview.sha256,
            receipt_hash_sha256: sha256Hex(`REFUSED:${refusal.code}:${planHashSha256}:${diffPreview.sha256}:${refusal.message}`),
            message: refusal.message,
            timestamp_local: timestampLocal,
            timestamp_utc: timestampUtc,
            repo_root: args.ctx.repoRoot,
            invocation: intake,
        });

        receipt?.writeJson("final.json", {
            ok: false,
            status: "REFUSED",
            decision_code: refusal.code,
            stage: "execution",
            planId: plan.planId,
            ...(warnings.length ? { warnings } : {}),
            refusal: { code: refusal.code, reason: refusal.message }
        });
        const finalized = receipt?.finalize();
        return {
            ok: false,
            capability: plan.steps[0]?.tool?.name,
            plan,
            ...(warnings.length ? { warnings } : {}),
            refusal: { code: refusal.code, reason: refusal.message },
            ...(finalized ? { receipt: finalized } : {})
        };
    }
}
