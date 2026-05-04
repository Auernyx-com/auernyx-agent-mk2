export type RefusalReasonCode =
    // Governance
    | "NO_AUTHORITY"
    | "POLICY_CONFLICT"
    | "POLICY_MISSING"
    | "HIL_REQUIRED"
    // Risk
    | "RISK_EXCEEDS_THRESHOLD"
    | "LOOSENING_REQUIRES_CONTROLLED_APPROVAL"
    // Data / Preconditions
    | "INPUT_UNVERIFIED"
    | "INPUT_AMBIGUOUS"
    | "PRECONDITIONS_NOT_MET"
    // Audit / Integrity
    | "AUDIT_INVARIANT_VIOLATION"
    | "LEDGER_PROTECTION";

export type RiskClass = "WITHIN_TOLERANCE" | "CONTROLLED" | "FAILED_CLOSED";

export const REASONS_VERSION = 1 as const;
