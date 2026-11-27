import type { RouterContext } from "../core/router";
import { readGovernanceLock, writeGovernanceLock } from "../core/governanceLock";
import { runSelfTestChecks } from "../core/selfTestChecks";

export async function governanceSelfTest(ctx: RouterContext, _input?: unknown): Promise<unknown> {
    // The checks themselves live in core/selfTestChecks.ts, shared with
    // governanceUnlock so that clearing the lock re-checks the same things.
    const checks = await runSelfTestChecks(ctx);
    const now = checks.timestamp;

    // If integrity is already broken, lock immediately.
    if (checks.stoppedAtIntegrity) {
        const current = readGovernanceLock(ctx.repoRoot);
        const next = {
            locked: true,
            reason: current.locked && current.reason
                ? current.reason
                : `The audit ledger failed its integrity check — the hash chain could not be verified.${checks.warnings.length ? " First issue: " + checks.warnings[0] : ""} No further operations are permitted until a human reviewer confirms the ledger is sound.`,
            lastSelfTest: { timestamp: now, ok: false, warnings: checks.warnings },
        };
        writeGovernanceLock(ctx.repoRoot, next);
        return { ok: false, warnings: checks.warnings, lock: next };
    }

    // 2026-11-27: the reason used to be chosen on whether the tripwire write
    // was refused, which is the PASSING case. A working guard plus a critical
    // Ghost deviation therefore locked with "A write to a protected audit path
    // was not blocked". Each reason now names the check that actually failed.
    const tripwireFailed = checks.failedChecks.includes("tripwire");
    const ghostCriticalFail = checks.failedChecks.includes("ghost_critical");

    const current = readGovernanceLock(ctx.repoRoot);
    const next = {
        locked: !checks.ok,
        reason: checks.ok
            ? undefined
            : tripwireFailed
                ? "A write to a protected audit path was not blocked — the guard that should have refused it did not respond correctly. This is a critical protection failure. System closed until this is manually reviewed and confirmed safe."
                : ghostCriticalFail
                    ? "Ghost verification detected a critical dual-witness deviation — the two protected path witnesses no longer agree on a critical system. Something may have modified one of the protection layers without authorization. Full stop until a human reviews both lists and confirms they match."
                    : "The governance self-test did not pass — a check the system runs on itself came back wrong. System closed as a precaution. Review the warnings and run the self-test again after the issue is resolved.",
        lastSelfTest: { timestamp: now, ok: checks.ok, warnings: checks.warnings },
    };

    // Preserve an existing stronger reason if already locked.
    if (current.locked && current.reason && !checks.ok) {
        next.reason = current.reason;
    }

    writeGovernanceLock(ctx.repoRoot, next);

    return {
        ok: checks.ok,
        warnings: checks.warnings,
        lock: next,
        refusal: checks.refusal,
        ghostVerification: checks.ghostResult && !checks.ghostResult.ok ? { deviations: checks.ghostResult.deviations } : undefined,
    };
}
