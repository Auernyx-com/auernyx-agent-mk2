import type { RouterContext } from "../core/router";
import * as path from "path";
import { guardedWriteFile } from "../core/guardedFs";
import { GovernanceRefusalError } from "../core/governanceRefusal";
import { readGovernanceLock, writeGovernanceLock } from "../core/governanceLock";
import { recordRefusal, verifyKintsugiIntegrity } from "../core/kintsugi/memory";

function illegalTarget(repoRoot: string): string {
    return path.join(repoRoot, ".auernyx", "kintsugi", "ledger", "records", "SELFTEST_DO_NOT_WRITE.txt");
}

export async function governanceSelfTest(ctx: RouterContext, _input?: unknown): Promise<unknown> {
    const beforeIntegrity = await verifyKintsugiIntegrity(ctx.repoRoot);

    const now = new Date().toISOString();

    // If integrity is already broken, lock immediately.
    if (!beforeIntegrity.ok) {
        const current = readGovernanceLock(ctx.repoRoot);
        const next = {
            locked: true,
            reason: current.locked && current.reason ? current.reason : "ledger integrity failed",
            lastSelfTest: { timestamp: now, ok: false, warnings: beforeIntegrity.warnings },
        };
        writeGovernanceLock(ctx.repoRoot, next);
        return { ok: false, warnings: beforeIntegrity.warnings, lock: next };
    }

    // Tripwire: attempt a protected-path write. This must be refused by the guard.
    let refused: any = undefined;
    let ok = false;
    try {
        guardedWriteFile(ctx.repoRoot, illegalTarget(ctx.repoRoot), "SELFTEST", "governance:selfTest", "Attempt illegal protected write (self-test)");
        ok = false;
    } catch (err) {
        if (err instanceof GovernanceRefusalError) {
            refused = err.refusal;
            ok = err.refusal.refusalReason === "LEDGER_PROTECTION";

            // Evidence: record the refusal in the ledger if available.
            ctx.ledger?.append(ctx.sessionId, "governance.refusal", {
                ...err.refusal,
                timestamp: now,
            });

            // Evidence: record the refusal in Kintsugi ledger as an MRR.
            await recordRefusal(ctx.repoRoot, {
                system: err.refusal.system,
                requested_action: err.refusal.requestedAction,
                refusal_reason: "LEDGER_PROTECTION",
                policy_refs: err.refusal.policyRefs,
                risk_level: "CRITICAL",
                what_would_be_required: err.refusal.whatWouldBeRequired,
                notes: err.refusal.notes,
            });
        } else {
            ok = false;
        }
    }

    const afterIntegrity = await verifyKintsugiIntegrity(ctx.repoRoot);
    if (!afterIntegrity.ok) {
        ok = false;
    }

    const current = readGovernanceLock(ctx.repoRoot);
    const next = {
        locked: ok ? false : true,
        reason: ok
            ? undefined
            : refused
                ? "Governance self-test failed: illegal mutation was not refused by guard"
                : "Governance self-test failed",
        lastSelfTest: { timestamp: now, ok, warnings: afterIntegrity.warnings },
    };

    // Preserve an existing stronger reason if already locked.
    if (current.locked && current.reason && !ok) {
        next.reason = current.reason;
    }

    writeGovernanceLock(ctx.repoRoot, next);

    return {
        ok,
        warnings: afterIntegrity.warnings,
        lock: next,
        refusal: refused,
    };
}
