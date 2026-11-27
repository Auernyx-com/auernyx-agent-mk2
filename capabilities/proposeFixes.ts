import type { RouterContext } from "../core/router";
import { GovernanceRefusalError } from "../core/governanceRefusal";
import { getKintsugiPolicy, policyHash, recordHumanApprovedPolicyChange, verifyKintsugiIntegrity } from "../core/kintsugi/memory";

type Suggestion = {
    id: string;
    label: string;
    detail: string;
    patch: unknown;
};

type ProposeFixesInput = {
    apply?: boolean;
    suggestionId?: string;
};

function isLooseningPolicy(before: any, after: any): boolean {
    // Any move TO CONTROLLED unlocks Tier 2 (router.ts), whatever the starting
    // value: FAILED_CLOSED, WITHIN_TOLERANCE, or an unvalidated string from
    // active.policy.json. Previously only WITHIN_TOLERANCE -> CONTROLLED was
    // caught, so FAILED_CLOSED -> CONTROLLED skipped typed APPLY.
    if (before?.riskTolerance !== "CONTROLLED" && after?.riskTolerance === "CONTROLLED") return true;
    if (before?.confirmArtifactWrites === true && after?.confirmArtifactWrites === false) return true;
    if (before?.rollbackRequiresIntegrityPass === true && after?.rollbackRequiresIntegrityPass === false) return true;
    if (before?.allowRollback === false && after?.allowRollback === true) return true;
    if (before?.rollbackRiskClass === "CONTROLLED" && after?.rollbackRiskClass === "WITHIN_TOLERANCE") return true;
    return false;
}

// Fail closed: WITHIN_TOLERANCE and CONTROLLED are the only open states.
// FAILED_CLOSED counts as closed, and so does any value outside the three
// canonical states (drift or tampering; Feneris raises
// kintsugi-policy-invalid for those), because an unknown state is treated as
// the strictest one, never a looser one.
function isFailClosed(riskTolerance: unknown): boolean {
    return riskTolerance !== "WITHIN_TOLERANCE" && riskTolerance !== "CONTROLLED";
}

function failClosedReason(riskTolerance: unknown): string {
    return `Kintsugi policy is fail-closed (riskTolerance=${JSON.stringify(riskTolerance) ?? "missing"}). ` +
        "Loosening changes are refused, even with typed APPLY. Leaving FAILED_CLOSED is a separate recovery step " +
        "(cause cleared + human approval); proposeFixes never does it.";
}

export async function proposeFixes(ctx: RouterContext, input?: unknown): Promise<unknown> {
    const parsed = (input ?? {}) as Partial<ProposeFixesInput>;
    const policy = getKintsugiPolicy(ctx.repoRoot);
    const integrity = await verifyKintsugiIntegrity(ctx.repoRoot);
    const suggestions: Suggestion[] = [];

    if (policy.riskTolerance !== "CONTROLLED") {
        suggestions.push({
            id: "enable-riskTolerance-controlled",
            label: "Elevate riskTolerance to CONTROLLED",
            detail: "Authorizes Tier 2 operations. Deliberate, receipted, requires typed APPLY.",
            patch: { riskTolerance: "CONTROLLED" },
        });
    }

    if (policy.confirmArtifactWrites) {
        suggestions.push({
            id: "disable-confirmArtifactWrites",
            label: "Disable confirmArtifactWrites",
            detail: "Removes human confirmation gate for workspace mutations (loosening).",
            patch: { confirmArtifactWrites: false },
        });
    }

    if (!policy.strictPreflightForArtifactWrites) {
        suggestions.push({
            id: "enable-strictPreflightForArtifactWrites",
            label: "Enable strictPreflightForArtifactWrites",
            detail: "Adds extra preflight checks before governed writes (tightening).",
            patch: { strictPreflightForArtifactWrites: true },
        });
    }

    if (policy.rollbackRequiresIntegrityPass && !integrity.ok) {
        suggestions.push({
            id: "disable-rollbackRequiresIntegrityPass",
            label: "Disable rollbackRequiresIntegrityPass",
            detail: "Allows rollback even when integrity warnings exist (loosening).",
            patch: { rollbackRequiresIntegrityPass: false },
        });
    }

    // Apply option: patch config/auernyx.config.json.
    if (parsed.apply) {
        const suggestionId = String(parsed.suggestionId ?? "").trim();
        if (!suggestionId) throw new Error("suggestionId is required when apply=true");
        const picked = suggestions.find((s) => s.id === suggestionId);
        if (!picked) throw new Error(`Unknown/unsupported suggestionId: ${suggestionId}`);

        const before = getKintsugiPolicy(ctx.repoRoot);
        const after = { ...before, ...(picked.patch as any) };
        const loosening = isLooseningPolicy(before, after);
        const riskLevel = loosening ? "ELEVATED" : "CONTROLLED";

        // 2026-11-27: typed APPLY used to be the only thing between
        // FAILED_CLOSED and CONTROLLED, and CONTROLLED unlocks Tier 2 in
        // router.ts. This capability is Tier 1, so the router lets it run in
        // FAILED_CLOSED. Checked before the typed-APPLY gate on purpose: no
        // confirmation can loosen a fail-closed policy from inside.
        if (loosening && isFailClosed(before.riskTolerance)) {
            throw new GovernanceRefusalError({
                system: "kintsugi:policy",
                requestedAction: `Apply policy suggestion ${picked.id}`,
                refusalReason: "RISK_EXCEEDS_THRESHOLD",
                policyRefs: ["riskTolerance"],
                riskLevel: "CRITICAL",
                whatWouldBeRequired: "riskTolerance must be WITHIN_TOLERANCE or CONTROLLED before any loosening change",
                notes: failClosedReason(before.riskTolerance),
            });
        }

        // Was `riskLevel === "CONTROLLED"` — the inverse of what the refusal's
        // own name and message say. loosening=true sets riskLevel="ELEVATED"
        // two lines up; the condition as written required typed APPLY only for
        // the *non*-loosening (tightening) suggestions, and let every loosening
        // change through with zero confirmation. Verified directly before
        // fixing: applying "disable-confirmArtifactWrites" (removes the human
        // confirmation gate for workspace mutations — about as loosening as
        // this list gets) succeeded with ok:true and no approval.confirm at
        // all. The sibling capability (rollbackKnownGood.ts) gates its own
        // typed-APPLY requirement on the higher-risk classification, matching
        // plain reading of "ELEVATED" — this now does the same.
        if (riskLevel === "ELEVATED" && ctx.approval?.confirm !== "APPLY") {
            throw new GovernanceRefusalError({
                system: "kintsugi:policy",
                requestedAction: `Apply policy suggestion ${picked.id}`,
                refusalReason: "LOOSENING_REQUIRES_CONTROLLED_APPROVAL",
                policyRefs: ["approval.confirm"],
                riskLevel: "HIGH",
                whatWouldBeRequired: "Provide approval.confirm=APPLY",
                notes: "Controlled confirmation required for loosening policy changes.",
            });
        }

        await recordHumanApprovedPolicyChange(ctx.repoRoot, {
            suggestionId: picked.id,
            reason: picked.label,
            before,
            after,
            riskLevel,
            blastRadius: ["kintsugi-policy"],
        });

        ctx.ledger?.append(ctx.sessionId, "proposeFixes.applied", { applied: picked.id, patch: picked.patch, riskLevel });

        return { ok: true, applied: picked.id, patch: picked.patch, riskLevel };
    }

    // A fail-closed policy is never offered a loosening suggestion: the apply
    // path above would refuse it anyway, so listing it would only mislead.
    if (isFailClosed(policy.riskTolerance)) {
        const isLoosening = (s: Suggestion) => isLooseningPolicy(policy, { ...policy, ...(s.patch as any) });
        return {
            ok: true,
            integrity,
            policy,
            policyHash: policyHash(policy),
            suggestions: suggestions.filter((s) => !isLoosening(s)),
            withheld: {
                ids: suggestions.filter(isLoosening).map((s) => s.id),
                reason: failClosedReason(policy.riskTolerance),
            },
        };
    }

    return {
        ok: true,
        integrity,
        policy,
        policyHash: policyHash(policy),
        suggestions,
    };
}
