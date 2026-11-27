import type { RouterContext } from "../core/router";
import { verifyLedgerIntegrity } from "../core/integrity";
import { readGovernanceLock, writeGovernanceLock } from "../core/governanceLock";
import { runSelfTestChecks } from "../core/selfTestChecks";
import { getKintsugiPolicy, isRiskToleranceFailClosed, recordHumanApprovedPolicyChange } from "../core/kintsugi/memory";

export async function governanceUnlock(ctx: RouterContext, _input?: unknown): Promise<unknown> {
    const current = readGovernanceLock(ctx.repoRoot);

    // governanceUnlock is also the one way out of Kintsugi FAILED_CLOSED
    // (Justin's decision, 2026-11-27), including an unknown riskTolerance
    // value, which counts as FAILED_CLOSED. Leaving it drops only to
    // WITHIN_TOLERANCE, never to CONTROLLED.
    const policy = getKintsugiPolicy(ctx.repoRoot);
    const failClosed = isRiskToleranceFailClosed(policy.riskTolerance);

    if (!current.locked && !failClosed) return { ok: true, alreadyUnlocked: true };

    // Leaving FAILED_CLOSED loosens the Kintsugi policy, so it needs typed
    // APPLY like every other loosening change, on top of the router's
    // approval + approver identity. Checked first: without it nothing is
    // verified or written, and a lock held at the same time stays held too.
    if (failClosed && ctx.approval?.confirm !== "APPLY") {
        ctx.ledger?.append(ctx.sessionId, "governance.unlock.refused", {
            reason: "HIL_REQUIRED",
            riskTolerance: policy.riskTolerance,
        });
        return {
            ok: false,
            error: "HIL_REQUIRED",
            whatWouldBeRequired: "Leaving Kintsugi FAILED_CLOSED needs typed APPLY (approval.confirm=APPLY)",
            riskTolerance: policy.riskTolerance,
        };
    }

    const integrity = verifyLedgerIntegrity(ctx.repoRoot);
    // Independent-audit finding (2026-09-08, round 10, medium): verifyLedgerIntegrity()
    // only checks the last maxEntries lines when the ledger is longer than
    // that -- the boundary entry's own linkage is never verified, so a
    // tampered or fabricated prefix ahead of the checked window went
    // completely undetected (integrity.ok === true, checkedEntries equal to
    // the window size, no indication the earlier history was never looked
    // at). This is the one caller in the whole codebase where that check's
    // result actually gates a real governance decision -- fail closed
    // rather than unlock on a check that only covers recent history.
    if (!integrity.ok || integrity.truncated) {
        const reason = integrity.ok ? "AUDIT_LEDGER_UNVERIFIED_PREFIX" : "AUDIT_INVARIANT_VIOLATION";
        ctx.ledger?.append(ctx.sessionId, "governance.unlock.refused", {
            reason,
            warnings: integrity.warnings,
        });
        return {
            ok: false,
            error: reason,
            whatWouldBeRequired: integrity.truncated
                ? "Ledger has grown beyond what can be fully verified from genesis in one check " +
                  "(see integrity.warnings) -- archive/rotate older ledger entries before unlocking"
                : "Ledger integrity must validate (hash chain)",
            warnings: integrity.warnings,
        };
    }

    // 2026-11-27: the lock used to clear on the audit-ledger check above
    // alone. Only the self-test trips the lock, and none of its causes
    // (Kintsugi ledger integrity, the protected-path tripwire, a critical
    // Ghost deviation) live in the audit ledger, so unlock cleared every one
    // of them while the cause was still there. Re-run the self-test's own
    // checks and stay locked if any still fails.
    const checks = await runSelfTestChecks(ctx);
    if (!checks.ok) {
        ctx.ledger?.append(ctx.sessionId, "governance.unlock.refused", {
            reason: "PRECONDITIONS_NOT_MET",
            failedChecks: checks.failedChecks,
            warnings: checks.warnings,
        });
        return {
            ok: false,
            error: "PRECONDITIONS_NOT_MET",
            failedChecks: checks.failedChecks,
            whatWouldBeRequired: "Every self-test check must pass again before the lock clears or FAILED_CLOSED lifts: fix what failed " +
                "(see failedChecks and warnings), then retry",
            warnings: checks.warnings,
            lockReason: current.reason,
        };
    }

    const result: { ok: true; unlockedFrom?: string; riskTolerance?: { from: unknown; to: "WITHIN_TOLERANCE" } } = { ok: true };

    // Policy first: if the Kintsugi write fails, the lock is left untouched.
    if (failClosed) {
        const after = { ...policy, riskTolerance: "WITHIN_TOLERANCE" as const };
        await recordHumanApprovedPolicyChange(ctx.repoRoot, {
            suggestionId: "governance-unlock:failed-closed-exit",
            reason: "Leave FAILED_CLOSED: typed APPLY given, audit ledger and every self-test check passed (governanceUnlock)",
            before: policy,
            after,
            riskLevel: "ELEVATED",
            blastRadius: ["kintsugi-policy"],
        });
        ctx.ledger?.append(ctx.sessionId, "governance.unlock.failed_closed_exit", {
            from: policy.riskTolerance,
            to: "WITHIN_TOLERANCE",
        });
        result.riskTolerance = { from: policy.riskTolerance, to: "WITHIN_TOLERANCE" };
    }

    if (current.locked) {
        const unlocked = { locked: false, reason: undefined, lastSelfTest: { timestamp: checks.timestamp, ok: true, warnings: checks.warnings } };
        writeGovernanceLock(ctx.repoRoot, unlocked);
        ctx.ledger?.append(ctx.sessionId, "governance.unlock", { unlockedFrom: current.reason ?? "(unset)" });
        result.unlockedFrom = current.reason ?? "(unset)";
    }

    return result;
}
