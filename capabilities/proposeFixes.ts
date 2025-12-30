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
    if (before?.riskTolerance === "SAFE" && after?.riskTolerance === "CONTROLLED") return true;
    if (before?.confirmArtifactWrites === true && after?.confirmArtifactWrites === false) return true;
    if (before?.rollbackRequiresIntegrityPass === true && after?.rollbackRequiresIntegrityPass === false) return true;
    if (before?.allowRollback === false && after?.allowRollback === true) return true;
    if (before?.rollbackRiskClass === "CONTROLLED" && after?.rollbackRiskClass === "SAFE") return true;
    return false;
}

export async function proposeFixes(ctx: RouterContext, input?: unknown): Promise<unknown> {
    const parsed = (input ?? {}) as Partial<ProposeFixesInput>;
    const policy = getKintsugiPolicy(ctx.repoRoot);
    const integrity = await verifyKintsugiIntegrity(ctx.repoRoot);
    const suggestions: Suggestion[] = [];

    if (policy.riskTolerance !== "CONTROLLED") {
        suggestions.push({
            id: "enable-riskTolerance-controlled",
            label: "Enable riskTolerance=CONTROLLED",
            detail: "Allows CONTROLLED operations (still requires typed APPLY).",
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
        const riskLevel = loosening ? "CONTROLLED" : "SAFE";

        if (riskLevel === "CONTROLLED" && ctx.approval?.confirm !== "APPLY") {
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

    return {
        ok: true,
        integrity,
        policy,
        policyHash: policyHash(policy),
        suggestions,
    };
}
