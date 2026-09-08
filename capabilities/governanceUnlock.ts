import type { RouterContext } from "../core/router";
import { verifyLedgerIntegrity } from "../core/integrity";
import { readGovernanceLock, writeGovernanceLock } from "../core/governanceLock";

export async function governanceUnlock(ctx: RouterContext, _input?: unknown): Promise<unknown> {
    const current = readGovernanceLock(ctx.repoRoot);
    if (!current.locked) return { ok: true, alreadyUnlocked: true };

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

    const unlocked = { locked: false, reason: undefined, lastSelfTest: current.lastSelfTest };
    writeGovernanceLock(ctx.repoRoot, unlocked);
    ctx.ledger?.append(ctx.sessionId, "governance.unlock", { unlockedFrom: current.reason ?? "(unset)" });
    return { ok: true, unlockedFrom: current.reason ?? "(unset)" };
}
