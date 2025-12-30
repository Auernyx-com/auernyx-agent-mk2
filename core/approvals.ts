import type { CapabilityName } from "./policy";

export interface Approval {
    approvedBy: "human";
    at: string; // ISO-8601
    reason: string;

    // Optional governance hardening fields.
    identity?: string;
    confirm?: "APPLY";
}

export function createHumanApproval(reason: string, options?: { identity?: string; confirm?: "APPLY" }): Approval {
    return {
        approvedBy: "human",
        at: new Date().toISOString(),
        reason,
        identity: typeof options?.identity === "string" ? options.identity : undefined,
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
