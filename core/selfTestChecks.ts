import * as path from "path";
import type { RouterContext } from "./router";
import { loadConfig } from "./config";
import { guardedWriteFile } from "./guardedFs";
import { GovernanceRefusalError, type GovernanceRefusal } from "./governanceRefusal";
import { recordRefusal, recordFailure, makeMfr, makeSnapshotHash, verifyKintsugiIntegrity } from "./kintsugi/memory";
import { runGhostVerification, type GhostVerificationResult } from "./kintsugi/ghostVerification";

// The checks the governance self-test runs on the system itself, shared with
// governanceUnlock so that clearing the lock re-checks the same things that
// trip it. A lock must never clear while its cause is still there
// (2026-11-27: unlock used to check only the main audit ledger, which none of
// these checks touch).
//
// Records its evidence exactly as the self-test always has (tripwire MRR,
// Ghost MFR). Never reads or writes the governance lock: the callers decide
// what the result means for the lock.

export type SelfTestCheckName = "kintsugi_integrity" | "tripwire" | "ghost_critical";

export type SelfTestChecks = {
    ok: boolean;
    timestamp: string;
    failedChecks: SelfTestCheckName[];
    warnings: string[];
    // The Kintsugi ledger was already broken, so the tripwire and Ghost never ran.
    stoppedAtIntegrity: boolean;
    refusal?: GovernanceRefusal;
    ghostResult?: GhostVerificationResult;
};

function illegalTarget(repoRoot: string): string {
    return path.join(repoRoot, ".auernyx", "kintsugi", "ledger", "records", "SELFTEST_DO_NOT_WRITE.txt");
}

export async function runSelfTestChecks(ctx: RouterContext): Promise<SelfTestChecks> {
    const beforeIntegrity = await verifyKintsugiIntegrity(ctx.repoRoot);
    const timestamp = new Date().toISOString();

    // If integrity is already broken, stop here: nothing after this can be trusted.
    if (!beforeIntegrity.ok) {
        return {
            ok: false,
            timestamp,
            failedChecks: ["kintsugi_integrity"],
            warnings: beforeIntegrity.warnings,
            stoppedAtIntegrity: true,
        };
    }

    // Tripwire: attempt a protected-path write. This must be refused by the guard.
    let refusal: GovernanceRefusal | undefined;
    let tripwireOk = false;
    try {
        guardedWriteFile(ctx.repoRoot, illegalTarget(ctx.repoRoot), "SELFTEST", "governance:selfTest", "Attempt illegal protected write (self-test)");
    } catch (err) {
        if (err instanceof GovernanceRefusalError) {
            refusal = err.refusal;
            tripwireOk = err.refusal.refusalReason === "LEDGER_PROTECTION";

            // Evidence: record the refusal in the ledger if available.
            ctx.ledger?.append(ctx.sessionId, "governance.refusal", {
                ...err.refusal,
                timestamp,
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
        }
    }

    const afterIntegrity = await verifyKintsugiIntegrity(ctx.repoRoot);

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
    }
    // Non-critical deviations: degraded ops continue, HIL flag surfaces in warnings.

    const failedChecks: SelfTestCheckName[] = [];
    if (!tripwireOk) failedChecks.push("tripwire");
    if (!afterIntegrity.ok) failedChecks.push("kintsugi_integrity");
    // Critical system deviation: FAILED_CLOSED. This is the last line before damage.
    if (ghostResult.criticalDeviations.length > 0) failedChecks.push("ghost_critical");

    return {
        ok: failedChecks.length === 0,
        timestamp,
        failedChecks,
        warnings: [...afterIntegrity.warnings, ...ghostWarnings],
        stoppedAtIntegrity: false,
        refusal,
        ghostResult,
    };
}
