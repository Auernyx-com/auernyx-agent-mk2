import * as path from "path";
import { isProtectedWorkspacePath } from "./kintsugi/protectedPaths";

export type RefusalReason =
    | "NO_AUTHORITY"
    | "POLICY_CONFLICT"
    | "POLICY_MISSING"
    | "HIL_REQUIRED"
    | "RISK_EXCEEDS_THRESHOLD"
    | "LOOSENING_REQUIRES_CONTROLLED_APPROVAL"
    | "INPUT_UNVERIFIED"
    | "INPUT_AMBIGUOUS"
    | "PRECONDITIONS_NOT_MET"
    | "AUDIT_INVARIANT_VIOLATION"
    | "LEDGER_PROTECTION";

export type GovernanceRefusal = {
    system: string;
    requestedAction: string;
    refusalReason: RefusalReason;
    policyRefs: string[];
    riskLevel: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
    whatWouldBeRequired: string;
    notes?: string;
};

export class GovernanceRefusalError extends Error {
    public readonly refusal: GovernanceRefusal;

    constructor(refusal: GovernanceRefusal) {
        super(`refused:${refusal.refusalReason}`);
        this.refusal = refusal;
    }
}

function normalizeRel(p: string): string {
    return String(p).replace(/\\/g, "/").replace(/^\/+/, "").trim();
}

export function isPathProtected(repoRoot: string, candidatePath: string, protectedPaths: string[]): boolean {
    const abs = path.resolve(candidatePath);
    const repo = path.resolve(repoRoot);
    const rel = normalizeRel(path.relative(repo, abs));
    if (!rel || rel.startsWith("..")) return false;

    if (isProtectedWorkspacePath(repoRoot, abs)) return true;

    const normalizedProtected = (protectedPaths ?? []).map(normalizeRel).filter(Boolean);

    for (const prot of normalizedProtected) {
        if (!prot) continue;
        if (rel.toLowerCase() === prot.toLowerCase()) return true;
        if (rel.toLowerCase().startsWith((prot + "/").toLowerCase())) return true;
    }
    return false;
}
