import type { RouterContext } from "../core/router";
import { GovernanceRefusalError } from "../core/governanceRefusal";
import { getApproverIdentity, getKintsugiPolicy, ledgerHasRecordHash, makeMfr, makeSnapshotHash, policyHash, recordFailure, recordHumanApprovedPolicyChange, verifyKintsugiIntegrity } from "../core/kintsugi/memory";
import { listKnownGoodSnapshotsWithPaths, type KnownGoodSnapshotEntry } from "../core/kintsugi/knownGood";
import * as fs from "fs";

export type RollbackInput =
    | { action?: "list"; limit?: number }
    | { action: "restore"; kgsId: string };

function daysBetween(aIso: string, bIso: string): number {
    const a = Date.parse(aIso);
    const b = Date.parse(bIso);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return Number.POSITIVE_INFINITY;
    return Math.abs(b - a) / (1000 * 60 * 60 * 24);
}

function parsePolicySnapshot(snapshotPath: string): { policy: any; policy_hash: string } {
    const raw = fs.readFileSync(snapshotPath, { encoding: "utf8" });
    const parsed = JSON.parse(raw) as any;
    return { policy: parsed?.policy, policy_hash: String(parsed?.policy_hash ?? "") };
}

function withinWindowAndDepth(
    entries: KnownGoodSnapshotEntry[],
    policy: ReturnType<typeof getKintsugiPolicy>
): KnownGoodSnapshotEntry[] {
    const now = new Date().toISOString();
    const within = entries.filter((e) => daysBetween(e.timestamp, now) <= policy.rollbackWindowDays);
    return within.slice(Math.max(0, within.length - policy.rollbackMaxDepth));
}

export async function rollbackKnownGood(ctx: RouterContext, input?: unknown): Promise<unknown> {
    const parsed = (input ?? {}) as Partial<RollbackInput>;
    const action = parsed.action ?? "list";

    const policy = getKintsugiPolicy(ctx.repoRoot);

    if (action === "list") {
        const limit = typeof (parsed as any).limit === "number" ? (parsed as any).limit : 20;
        const all = (await listKnownGoodSnapshotsWithPaths(ctx.repoRoot)).map((x) => x.entry);
        const candidates = withinWindowAndDepth(all, policy);

        return {
            policy: {
                allowRollback: policy.allowRollback,
                rollbackWindowDays: policy.rollbackWindowDays,
                rollbackMaxDepth: policy.rollbackMaxDepth,
                rollbackRequiresIntegrityPass: policy.rollbackRequiresIntegrityPass,
                rollbackRiskClass: policy.rollbackRiskClass,
            },
            entries: typeof limit === "number" ? candidates.slice(Math.max(0, candidates.length - limit)) : candidates,
            totalEntries: all.length,
        };
    }

    if (action === "restore") {
        if (!policy.allowRollback) {
            throw new GovernanceRefusalError({
                system: "kintsugi:rollback",
                requestedAction: "Rollback to Known Good",
                refusalReason: "POLICY_CONFLICT",
                policyRefs: ["allowRollback"],
                riskLevel: "HIGH",
                whatWouldBeRequired: "Enable Kintsugi policy allowRollback",
                notes: "Rollback is disabled by policy.",
            });
        }

        if (policy.rollbackRequiresIntegrityPass) {
            const integrity = await verifyKintsugiIntegrity(ctx.repoRoot);
            if (!integrity.ok) {
                throw new GovernanceRefusalError({
                    system: "kintsugi:rollback",
                    requestedAction: "Rollback to Known Good",
                    refusalReason: "AUDIT_INVARIANT_VIOLATION",
                    policyRefs: ["rollbackRequiresIntegrityPass"],
                    riskLevel: "CRITICAL",
                    whatWouldBeRequired: "Ledger integrity must validate (hash chain)",
                    notes: integrity.warnings.slice(0, 5).join(" | "),
                });
            }
        }

        const kgsId = String((parsed as any).kgsId ?? "").trim();
        if (!kgsId) throw new Error("kgsId is required for restore");

        const all = (await listKnownGoodSnapshotsWithPaths(ctx.repoRoot)).map((x) => x.entry);
        const candidates = withinWindowAndDepth(all, policy);
        const entry = candidates.find((e) => e.kgs_id === kgsId);

        if (!entry) {
            throw new GovernanceRefusalError({
                system: "kintsugi:rollback",
                requestedAction: `Rollback to ${kgsId}`,
                refusalReason: "PRECONDITIONS_NOT_MET",
                policyRefs: ["rollbackWindowDays", "rollbackMaxDepth"],
                riskLevel: "HIGH",
                whatWouldBeRequired: "Select a KGS within rollback window/depth",
                notes: "KGS is not within rollback window/depth constraints.",
            });
        }

        const headOk = await ledgerHasRecordHash(ctx.repoRoot, entry.ledger_head_hash);
        if (!headOk) {
            throw new GovernanceRefusalError({
                system: "kintsugi:rollback",
                requestedAction: `Rollback to ${kgsId}`,
                refusalReason: "AUDIT_INVARIANT_VIOLATION",
                policyRefs: [],
                riskLevel: "CRITICAL",
                whatWouldBeRequired: "A Known Good Snapshot whose ledger_head_hash exists in the current ledger chain",
                notes: "KGS ledger_head_hash not found in current ledger; chain continuity cannot be proven.",
            });
        }

        const snap = parsePolicySnapshot(entry.policy_snapshot_path);
        const computed = policyHash(snap.policy);
        if (snap.policy_hash && snap.policy_hash !== computed) {
            throw new GovernanceRefusalError({
                system: "kintsugi:rollback",
                requestedAction: `Rollback to ${kgsId}`,
                refusalReason: "AUDIT_INVARIANT_VIOLATION",
                policyRefs: [],
                riskLevel: "CRITICAL",
                whatWouldBeRequired: "An intact policy snapshot whose declared hash matches content",
                notes: "Policy snapshot hash mismatch.",
            });
        }
        if (entry.policy_hash && entry.policy_hash !== computed) {
            throw new GovernanceRefusalError({
                system: "kintsugi:rollback",
                requestedAction: `Rollback to ${kgsId}`,
                refusalReason: "AUDIT_INVARIANT_VIOLATION",
                policyRefs: [],
                riskLevel: "CRITICAL",
                whatWouldBeRequired: "An intact policy snapshot matching the KGS entry policy_hash",
                notes: "KGS entry policy_hash does not match snapshot content.",
            });
        }

        const rollbackClass = policy.rollbackRiskClass;
        const riskLevel: "CONTROLLED" | "ELEVATED" | "CRITICAL" =
            rollbackClass === "CONTROLLED" ? "ELEVATED" : "CONTROLLED";
        if (rollbackClass === "CONTROLLED" && ctx.approval?.confirm !== "APPLY") {
            throw new GovernanceRefusalError({
                system: "kintsugi:rollback",
                requestedAction: `Rollback to ${kgsId}`,
                refusalReason: "HIL_REQUIRED",
                policyRefs: ["rollbackRiskClass"],
                riskLevel: "HIGH",
                whatWouldBeRequired: "Human approval via typed APPLY (approval.confirm=APPLY)",
                notes: "CONTROLLED rollback blocked without typed APPLY.",
            });
        }

        const before = getKintsugiPolicy(ctx.repoRoot);
        const after = snap.policy;
        await recordHumanApprovedPolicyChange(ctx.repoRoot, {
            suggestionId: `rollback:${kgsId}`,
            reason: `Rollback to Known Good Snapshot (${kgsId})`,
            before,
            after,
            riskLevel,
            blastRadius: ["kintsugi-policy"],
        });

        await recordFailure(ctx.repoRoot, {
            ...makeMfr({
                system: "kintsugi:rollback",
                failure_type: "governance",
                trigger: "Rollback applied",
                inputs_snapshot: makeSnapshotHash({ kgs_id: kgsId, ledger_head_hash: entry.ledger_head_hash }),
                pre_state: policyHash(before),
                post_state: policyHash(after),
                recovery_action: "rollback",
                authorized_by: getApproverIdentity(ctx.repoRoot),
                notes: "Rollback executed under Kintsugi policy.",
            }),
            severity: riskLevel === "CONTROLLED" ? "HIGH" : "MEDIUM",
            normalized_error_code: "ROLLBACK_APPLIED",
        });

        ctx.ledger?.append(ctx.sessionId, "rollback.applied", {
            kgsId,
            policy: {
                rollbackWindowDays: policy.rollbackWindowDays,
                rollbackMaxDepth: policy.rollbackMaxDepth,
            },
        });

        return { restoredPolicyHash: policyHash(after), kgsId };
    }

    throw new Error(`Unknown action: ${String(action)}`);
}
