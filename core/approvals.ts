import type { CapabilityName } from "./policy";

export interface Approval {
    approvedBy: "human";
    at: string; // ISO-8601
    reason: string;

    // Optional governance hardening fields.
    identity?: string;
    // Explicit arming flag (maps to CLI `--apply` / command palette Apply).
    // Separate from the typed confirm phrase to support two-gate workflows.
    apply?: boolean;
    // Explicit override: allow controlled ops on dirty working tree.
    allowDirty?: boolean;
    confirm?: "APPLY";
}

export interface StepApproval extends Approval {
    stepId: string;
    evidenceRefs?: string[];
    acknowledgedRollbackPointIds?: string[];
}

export function createHumanApproval(
    reason: string,
    options?: { identity?: string; apply?: boolean; allowDirty?: boolean; confirm?: "APPLY" }
): Approval {
    return {
        approvedBy: "human",
        at: new Date().toISOString(),
        reason,
        identity: typeof options?.identity === "string" ? options.identity : undefined,
        apply: typeof options?.apply === "boolean" ? options.apply : undefined,
        allowDirty: typeof options?.allowDirty === "boolean" ? options.allowDirty : undefined,
        confirm: options?.confirm
    };
}

export function isValidApproval(approval: unknown): approval is Approval {
    if (!approval || typeof approval !== "object") return false;
    const a = approval as Record<string, unknown>;
    return (
        a.approvedBy === "human" &&
        typeof a.at === "string" &&
        typeof a.reason === "string" &&
        a.reason.trim().length > 0
    );
}

export function isValidStepApproval(approval: unknown): approval is StepApproval {
    if (!isValidApproval(approval)) return false;
    const a = approval as unknown as Record<string, unknown>;
    if (typeof a.stepId !== "string" || a.stepId.trim().length === 0) return false;
    if (a.evidenceRefs === undefined) return true;
    if (!Array.isArray(a.evidenceRefs)) return false;
    if (!(a.evidenceRefs as unknown[]).every((v) => typeof v === "string" && v.trim().length > 0)) return false;
    if (a.acknowledgedRollbackPointIds === undefined) return true;
    if (!Array.isArray(a.acknowledgedRollbackPointIds)) return false;
    return (a.acknowledgedRollbackPointIds as unknown[]).every((v) => typeof v === "string" && v.trim().length > 0);
}

export function approvalIdentity(approval: Approval | undefined): string | undefined {
    const v = approval?.identity;
    return typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined;
}

export class ApprovalRequiredError extends Error {
    public readonly code = "approval_required" as const;
    public readonly capability: CapabilityName;

    constructor(capability: CapabilityName) {
        super("approval_required");
        this.capability = capability;
    }
}
