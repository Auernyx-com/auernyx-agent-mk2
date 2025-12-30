import { capabilityRequiresApproval, CapabilityName, getCapabilityMeta, Policy } from "./policy";
import { Approval, ApprovalRequiredError, approvalIdentity, isValidApproval } from "./approvals";
import { loadConfig } from "./config";
import { readGovernanceLock } from "./governanceLock";

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
}

export type CapabilityFn = (ctx: RouterContext, input?: unknown) => Promise<unknown>;

export interface Router {
    route(intent: Intent): CapabilityName | null;
    run(capability: CapabilityName, ctx: RouterContext, input?: unknown, approval?: Approval): Promise<unknown>;
}

export function createRouter(policy: Policy, capabilities: Record<CapabilityName, CapabilityFn>): Router {
    return {
        route(intent: Intent): CapabilityName | null {
            const text = intent.raw.trim().toLowerCase();
            if (text.startsWith("scan")) return "scanRepo";
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
            }

            if (text.includes("docker")) return "docker";
            return null;
        },

        async run(capability: CapabilityName, ctx: RouterContext, input?: unknown, approval?: Approval): Promise<unknown> {
            if (!policy.isAllowed(capability)) {
                throw new Error(`Policy blocked capability: ${capability}`);
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

            if (capabilityRequiresApproval(capability)) {
                if (!isValidApproval(approval)) {
                    throw new ApprovalRequiredError(capability);
                }

                // Optional identity enforcement (parity with original governance).
                const expected = cfg.governance.approverIdentity;
                if (expected.trim().length > 0) {
                    const provided = approvalIdentity(approval);
                    if (!provided || provided.trim() !== expected.trim()) {
                        throw new Error("no_authority");
                    }
                }
            }
            const fn = capabilities[capability];
            return fn({ ...ctx, approval }, input);
        }
    };
}
