// mondayTier2Review — Monday-voiced briefing before any Tier 2 (HIGH_RISK) capability execution
// Before a human pulls the trigger on a high-risk operation, Monday presents exactly what
// the action does, what the risk is, whether it is reversible, and what must be submitted to proceed.
// Read-only, Tier 0. Does not execute anything — it prepares the human to decide.

import type { RouterContext } from "../core/router";
import type { CapabilityName } from "../core/policy";
import { getCapabilityMeta } from "../core/policy";
import { loadMondayPersona } from "../core/monday";
import { getKintsugiPolicy } from "../core/kintsugi/memory";

interface Tier2Descriptor {
    action: string;
    consequence: string;
    irreversible: boolean;
}

const TIER2_DESCRIPTORS: Partial<Record<CapabilityName, Tier2Descriptor>> = {
    rollbackKnownGood: {
        action: "Rolls the system back to a known-good snapshot.",
        consequence: "All changes made after the snapshot point will be lost. The ledger records the rollback but the changes are gone.",
        irreversible: true
    },
    governanceUnlock: {
        action: "Clears the active governance lock and restores write access system-wide.",
        consequence: "The system returns to normal operating mode. Resolve the underlying issue before unlocking — unlocking without fixing the cause will re-trigger the lock.",
        irreversible: false
    },
    docker: {
        action: "Executes Docker operations against the configured target.",
        consequence: "Container state changes immediately. Scope and impact depend on the specific operation being run.",
        irreversible: false
    },
    skjoldrFirewallApplyProfile: {
        action: "Applies a Skjoldr firewall profile to the active network configuration.",
        consequence: "Network rules change immediately on application. An incorrect profile can block legitimate traffic or open unintended access.",
        irreversible: false
    },
    skjoldrFirewallApplyRulesetFile: {
        action: "Applies a ruleset file directly to the Skjoldr firewall.",
        consequence: "Network rules change immediately. Verify the ruleset file contents before applying — there is no dry-run.",
        irreversible: false
    },
    skjoldrFirewallExportBaseline: {
        action: "Exports the current Skjoldr firewall state as a named baseline snapshot.",
        consequence: "Creates a point-in-time record. Lower risk than apply operations, but the snapshot becomes a restore target — accuracy matters.",
        irreversible: false
    },
    skjoldrFirewallRestoreBaseline: {
        action: "Restores the Skjoldr firewall to a previously exported baseline snapshot.",
        consequence: "All current firewall rules are replaced by the baseline. Rules added since the baseline was taken will be removed.",
        irreversible: true
    }
};

interface Tier2ReviewInput {
    capability?: string;
}

export async function mondayTier2Review(ctx: RouterContext, input?: unknown): Promise<unknown> {
    const persona = loadMondayPersona(ctx.repoRoot);
    const reviewInput = input as Tier2ReviewInput | undefined;
    const capabilityName = reviewInput?.capability as CapabilityName | undefined;

    if (!capabilityName) {
        return {
            monday: persona.member,
            status: "capability_required",
            message: `${persona.member}: Provide the capability name you want reviewed. Submit with { "capability": "<name>" }.`,
            tier2_capabilities: Object.keys(TIER2_DESCRIPTORS)
        };
    }

    const meta = getCapabilityMeta(capabilityName);
    if (!meta) {
        return {
            monday: persona.member,
            status: "unknown_capability",
            message: `${persona.member}: "${capabilityName}" is not a recognised capability.`
        };
    }

    if (meta.tier < 2) {
        return {
            monday: persona.member,
            status: "not_tier2",
            capability: capabilityName,
            actual_tier: meta.tier,
            message: `${persona.member}: "${capabilityName}" is Tier ${meta.tier} — it does not require a Tier 2 review. Standard approval applies.`
        };
    }

    const kintsugiPolicy = getKintsugiPolicy(ctx.repoRoot);
    const isControlled = kintsugiPolicy.riskTolerance === "CONTROLLED";
    const descriptor = TIER2_DESCRIPTORS[capabilityName];

    const lines: string[] = [
        `--- Tier 2 Review: ${capabilityName} ---`,
        ``,
        `${persona.member}:`,
        descriptor?.action ?? `"${capabilityName}" is a Tier 2 high-risk capability.`,
        ``,
        `Risk class:   HIGH_RISK (Tier 2)`,
        `Reversible:   ${descriptor ? (descriptor.irreversible ? "NO" : "YES") : "UNKNOWN"}`,
        ``,
        `Consequence:`,
        descriptor?.consequence ?? "Review the capability documentation before proceeding.",
    ];

    if (!isControlled) {
        lines.push(
            ``,
            `BLOCKED — risk tolerance is WITHIN_TOLERANCE.`,
            `Tier 2 operations require CONTROLLED mode.`,
            `Run proposeFixes first to elevate risk tolerance, then return here.`
        );
    } else {
        lines.push(
            ``,
            `Risk tolerance: CONTROLLED — Tier 2 execution is permitted.`,
            ``,
            `To proceed: submit the capability with a valid approval including:`,
            `  confirm: "APPLY"`,
            `  apply: true`,
            `  reason: <your stated reason>`,
            `  identity: <your approver identity if configured>`,
            ``,
            `The ledger will record this approval alongside the execution receipt.`
        );
    }

    return {
        monday: persona.member,
        status: isControlled ? "ready_for_approval" : "risk_tolerance_insufficient",
        capability: capabilityName,
        tier: meta.tier,
        irreversible: descriptor?.irreversible ?? null,
        risk_tolerance: kintsugiPolicy.riskTolerance,
        human_readable: lines.join("\n")
    };
}
