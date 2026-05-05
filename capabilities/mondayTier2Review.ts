// mondayTier2Review — Monday-voiced briefing before any Tier 2 (HIGH_RISK) capability execution
// Before a human pulls the trigger on a high-risk operation, Monday presents exactly what
// the action does, what the risk is, whether it is reversible, and what must be submitted to proceed.
// Read-only, Tier 0. Does not execute anything — it prepares the human to decide.

import type { RouterContext } from "../core/router";
import type { CapabilityName } from "../core/policy";
import { getCapabilityMeta } from "../core/policy";
import { loadMondayPersona } from "../core/monday";
import { getKintsugiPolicy } from "../core/kintsugi/memory";
import { getModuleTier2Descriptors, type ModuleTier2Descriptor } from "../core/moduleRegistry";

// Core descriptors are hardcoded and cannot be overridden by registry entries.
// This prevents a malicious or misconfigured registry from lying to humans about
// the risk level or reversibility of these foundational operations.
const CORE_TIER2_DESCRIPTORS: Partial<Record<string, ModuleTier2Descriptor>> = {
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
    }
};

interface Tier2ReviewInput {
    capability?: string;
}

export async function mondayTier2Review(ctx: RouterContext, input?: unknown): Promise<unknown> {
    const persona = loadMondayPersona(ctx.repoRoot);
    const reviewInput = input as Tier2ReviewInput | undefined;
    const capabilityName = reviewInput?.capability as CapabilityName | undefined;

    // Registry descriptors are merged under core — core always wins on conflict.
    const allDescriptors: Partial<Record<string, ModuleTier2Descriptor>> = {
        ...getModuleTier2Descriptors(ctx.repoRoot),
        ...CORE_TIER2_DESCRIPTORS
    };

    if (!capabilityName) {
        return {
            monday: persona.member,
            status: "capability_required",
            message: `${persona.member}: Provide the capability name you want reviewed. Submit with { "capability": "<name>" }.`,
            tier2_capabilities: Object.keys(allDescriptors)
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
    const descriptor = allDescriptors[capabilityName];

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
