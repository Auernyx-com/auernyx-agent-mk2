import type { RouterContext } from "../core/router";
import { verifyLedgerIntegrity } from "../core/integrity";
import { readGovernanceLock, writeGovernanceLock } from "../core/governanceLock";

export async function governanceUnlock(ctx: RouterContext, _input?: unknown): Promise<unknown> {
    const current = readGovernanceLock(ctx.repoRoot);
    if (!current.locked) return { ok: true, alreadyUnlocked: true };

    const integrity = verifyLedgerIntegrity(ctx.repoRoot);
    if (!integrity.ok) {
        ctx.ledger?.append(ctx.sessionId, "governance.unlock.refused", {
            reason: "AUDIT_INVARIANT_VIOLATION",
            warnings: integrity.warnings,
        });
        return {
            ok: false,
            error: "AUDIT_INVARIANT_VIOLATION",
            whatWouldBeRequired: "Ledger integrity must validate (hash chain)",
            warnings: integrity.warnings,
        };
    }

    const unlocked = { locked: false, reason: undefined, lastSelfTest: current.lastSelfTest };
    writeGovernanceLock(ctx.repoRoot, unlocked);
    ctx.ledger?.append(ctx.sessionId, "governance.unlock", { unlockedFrom: current.reason ?? "(unset)" });
    return { ok: true, unlockedFrom: current.reason ?? "(unset)" };
}
