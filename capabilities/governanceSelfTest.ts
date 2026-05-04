import type { RouterContext } from "../core/router";
import * as path from "path";
import { loadConfig } from "../core/config";
import { guardedWriteFile } from "../core/guardedFs";
import { GovernanceRefusalError } from "../core/governanceRefusal";
import { readGovernanceLock, writeGovernanceLock } from "../core/governanceLock";
import { recordRefusal, recordFailure, makeMfr, makeSnapshotHash, verifyKintsugiIntegrity } from "../core/kintsugi/memory";
import { runGhostVerification } from "../core/kintsugi/ghostVerification";

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
            reason: current.locked && current.reason
                ? current.reason
                : `The audit ledger failed its integrity check — the hash chain could not be verified.${beforeIntegrity.warnings.length ? " First issue: " + beforeIntegrity.warnings[0] : ""} No further operations are permitted until a human reviewer confirms the ledger is sound.`,
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

    // Ghost verification gate: Ghost independently derives its threat model and cross-checks
    // it against Mnema's authoritative protected path list. If they disagree on a critical
    // system, this is a dual-witness failure — something got past canary AND the tripwire.
    const cfg = loadConfig(ctx.repoRoot);
    const ghostResult = runGhostVerification(cfg.governance.protectedPaths);
    const ghostWarnings: string[] = ghostResult.deviations.map(
        (d) =>
            `Ghost deviation on "${d.label}": inGhost=${d.inGhostThreatModel}, inMnema=${d.inMnemaList}` +
            (d.critical ? " [CRITICAL — dual-witness failure]" : " [non-critical — HIL review required]")
    );

    if (!ghostResult.ok) {
        // Ghost detected a deviation — record it to the Kintsugi ledger.
        // Ghost observes only; Kintsugi captures the record (Ueden role).
        await recordFailure(ctx.repoRoot, {
            ...makeMfr({
                system: "ghost:dualWitness",
                failure_type: "governance",
                trigger: "Ghost verification detected deviation between threat model and Mnema protected path list",
                inputs_snapshot: makeSnapshotHash({ deviations: ghostResult.deviations }),
                pre_state: "witnesses_aligned",
                post_state: "witnesses_deviated",
                recovery_action: ghostResult.criticalDeviations.length > 0 ? "none" : "compensate",
                authorized_by: "",
                notes: ghostWarnings.join("; "),
            }),
            severity: ghostResult.criticalDeviations.length > 0 ? "CRITICAL" : "HIGH",
            normalized_error_code: "GHOST_DUAL_WITNESS_DEVIATION",
            signature: `governance::ghost:dualWitness::path-deviation::GHOST_DUAL_WITNESS_DEVIATION`,
            risk_level: ghostResult.criticalDeviations.length > 0 ? "CRITICAL" : "ELEVATED",
        });

        if (ghostResult.criticalDeviations.length > 0) {
            // Critical system deviation: FAILED_CLOSED. This is the last line before damage.
            ok = false;
        }
        // Non-critical deviations: degraded ops continue, HIL flag surfaces in warnings.
    }

    const allWarnings = [...afterIntegrity.warnings, ...ghostWarnings];
    const ghostCriticalFail = ghostResult.criticalDeviations.length > 0;

    const current = readGovernanceLock(ctx.repoRoot);
    const next = {
        locked: ok ? false : true,
        reason: ok
            ? undefined
            : refused
                ? "A write to a protected audit path was not blocked — the guard that should have refused it did not respond correctly. This is a critical protection failure. System closed until this is manually reviewed and confirmed safe."
                : ghostCriticalFail
                    ? "Ghost verification detected a critical dual-witness deviation — the two protected path witnesses no longer agree on a critical system. Something may have modified one of the protection layers without authorization. Full stop until a human reviews both lists and confirms they match."
                    : "The governance self-test did not pass — a check the system runs on itself came back wrong. System closed as a precaution. Review the warnings and run the self-test again after the issue is resolved.",
        lastSelfTest: { timestamp: now, ok, warnings: allWarnings },
    };

    // Preserve an existing stronger reason if already locked.
    if (current.locked && current.reason && !ok) {
        next.reason = current.reason;
    }

    writeGovernanceLock(ctx.repoRoot, next);

    return {
        ok,
        warnings: allWarnings,
        lock: next,
        refusal: refused,
        ghostVerification: ghostResult.ok ? undefined : { deviations: ghostResult.deviations },
    };
}
