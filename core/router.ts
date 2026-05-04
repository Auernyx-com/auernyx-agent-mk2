// Router module for Mk2
// Executes approved steps only, never thinks

import { capabilityRequiresApproval, CapabilityName, getCapabilityMeta, Policy } from "./policy";
import { Approval, ApprovalRequiredError, approvalIdentity, isValidApproval, isValidStepApproval, StepApproval } from "./approvals";
import { loadConfig } from "./config";
import { readGovernanceLock } from "./governanceLock";
import { isJudgmentActive } from "./provenance";
import { getKintsugiPolicy } from "./kintsugi/memory";
import type { PlanStep } from "./planner";

export interface Intent {
    raw: string;
}

export interface RouterContext {
    repoRoot: string;
    sessionId: string;

    // Optional: provided by core/server and CLI so capabilities can emit evidence.
    ledger?: {
        append(sessionId: string, event: string, data?: unknown): unknown;
    };

    // Attached by the router after validation.
    approval?: Approval;

    // Set only by the orchestrator (runLifecycle/daemon) to prove execution is plan-based.
    execution?: {
        planId: string;
        stepId: string;
    };
}

export type CapabilityFn = (ctx: RouterContext, input?: unknown) => Promise<unknown>;

export interface Router {
    route(intent: Intent): CapabilityName | null;
    executeStep(step: PlanStep, ctx: RouterContext, approval: StepApproval): Promise<unknown>;
    // Legacy entrypoint: disabled unless ctx.execution is present.
    run(capability: CapabilityName, ctx: RouterContext, input?: unknown, approval?: Approval): Promise<unknown>;
}

export function createRouter(policy: Policy, capabilities: Record<CapabilityName, CapabilityFn>): Router {
    async function runInternal(capability: CapabilityName, ctx: RouterContext, input?: unknown, approval?: Approval): Promise<unknown> {
        // Block any direct execution that isn't explicitly marked as plan-based.
        if (!ctx.execution) {
            throw new Error("direct_execution_disabled");
        }

        if (!policy.isAllowed(capability)) {
            throw new Error(`Policy blocked capability: ${capability}`);
        }

        // Obsidian's Judgment: when active, refuse all privileged (non-readOnly) capabilities.
        // Enforcement is behavioral; UI is downstream.
        if (isJudgmentActive(ctx.repoRoot)) {
            const meta = getCapabilityMeta(capability);
            if (!meta.readOnly) {
                throw new Error("obsidian_judgment_active");
            }
        }

        const cfg = loadConfig(ctx.repoRoot);
        const meta = getCapabilityMeta(capability);
        if (!cfg.writeEnabled && !meta.readOnly) {
            throw new Error("write_disabled");
        }

        // Governance lock: while locked, only allow minimal recovery/status operations.
        const lock = readGovernanceLock(ctx.repoRoot);
        if (lock.locked) {
            const allowedWhileLocked: CapabilityName[] = ["memoryCheck", "governanceSelfTest", "governanceUnlock"];
            if (!allowedWhileLocked.includes(capability)) {
                throw new Error(`governance_locked: ${lock.reason ?? "(unset)"}`);
            }
        }

        // Risk tolerance gate: Tier 2 operations require the policy to be explicitly
        // elevated to CONTROLLED. WITHIN_TOLERANCE is the default operating mode and
        // does not authorize high-risk capabilities. Use proposeFixes to elevate.
        const kintsugiPolicy = getKintsugiPolicy(ctx.repoRoot);
        if (meta.tier >= 2 && kintsugiPolicy.riskTolerance !== "CONTROLLED") {
            throw new Error("risk_tolerance_insufficient");
        }

        if (capabilityRequiresApproval(capability)) {
            if (!isValidApproval(approval)) {
                throw new ApprovalRequiredError(capability);
            }

            // Identity enforcement applies to controlled (non-readonly) operations only.
            // Read-only operations require a valid approval for audit trail but do not
            // require identity — routine checks should not be blocked by identity gate.
            const expected = cfg.governance.approverIdentity;
            if (!meta.readOnly && expected.trim().length > 0) {
                const provided = approvalIdentity(approval);
                if (!provided || provided.trim() !== expected.trim()) {
                    throw new Error("no_authority");
                }
            }
        }

        const fn = capabilities[capability];
        return fn({ ...ctx, approval }, input);
    }

    return {
        route(intent: Intent): CapabilityName | null {
            /**
             * Extracts and normalizes the raw text from the intent by trimming whitespace
             * and converting it to lowercase.
             *
             * @remarks
             * This ensures consistent text processing for downstream logic, such as intent matching.
             *
             * @param intent - The intent object containing the raw text to be processed.
             * @returns The normalized text string.
             */
            const text = intent.raw.trim().toLowerCase();
            if (text.startsWith("scan")) return "scanRepo";
            if (text.startsWith("search doc")) return "searchDocApply";
            if (text.includes("feneris")) return "fenerisPrep";
            if (text.includes("baseline pre")) return "baselinePre";
            if (text.includes("baseline post")) return "baselinePost";

            if (text.includes("memory")) return "memoryCheck";
            if (text.includes("propose fixes") || text.startsWith("fix") || text.includes("suggest fix")) return "proposeFixes";

            if (text.includes("governance") && (text.includes("self") || text.includes("selftest") || text.includes("self-test"))) {
                return "governanceSelfTest";
            }
            if (text.includes("governance") && text.includes("unlock")) return "governanceUnlock";

            if (text.includes("rollback") || text.includes("known good") || text.includes("known_good") || text.includes("kgs")) {
                return "rollbackKnownGood";
            }

            if (text.includes("skjoldr") || text.includes("firewall")) {
                if (text.includes("status")) return "skjoldrFirewallStatus";
                if (text.includes("export") && text.includes("baseline")) return "skjoldrFirewallExportBaseline";
                if (text.includes("restore") && text.includes("baseline")) return "skjoldrFirewallRestoreBaseline";
                if (text.includes("apply") && text.includes("profile")) return "skjoldrFirewallApplyProfile";
                if (text.includes("apply") && (text.includes("ruleset") || text.includes("rule set") || text.includes("file"))) {
                    return "skjoldrFirewallApplyRulesetFile";
                }
                if (text.includes("advise") || text.includes("advice") || text.includes("recommend")) {
                    if (text.includes("inbound") || text.includes("ib")) {
                        return "skjoldrFirewallAdviseInboundRuleSets";
                    }
                }
            }

            if (text.includes("analyze") && text.includes("dependency")) return "analyzeDependency";
            if (text.includes("docker")) return "docker";
            if (text.includes("monday") || text.includes("infraction review") || text.includes("hil review")) {
                return "mondayInfractionReview";
            }
            return null;
        },

        async executeStep(step: PlanStep, ctx: RouterContext, approval: StepApproval): Promise<unknown> {
            if (!ctx.execution || ctx.execution.stepId !== step.id) {
                throw new Error("direct_execution_disabled");
            }
            if (!isValidStepApproval(approval) || approval.stepId !== step.id) {
                throw new ApprovalRequiredError(step.tool.name);
            }

            const meta = getCapabilityMeta(step.tool.name);

            // Require APPLY for any non-readonly planned step.
            if (!meta.readOnly) {
                if ((approval as any)?.apply !== true) {
                    throw new Error("apply_flag_required");
                }
                if (approval.confirm !== "APPLY") {
                    throw new Error("confirm_required");
                }
            }

            // Reuse the same governance policy enforcement as legacy run.
            return runInternal(step.tool.name, ctx, step.input, approval);
        },

                async run(capability: CapabilityName, ctx: RouterContext, input?: unknown, approval?: Approval): Promise<unknown> {
                    return runInternal(capability, ctx, input, approval);
                }
            };
        }
