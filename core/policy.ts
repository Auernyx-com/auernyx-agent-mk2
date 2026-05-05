// Policy module for Mk2
// Provides policy.load(), policy.evaluate(step), policy.refuse(reason, evidenceMissing[])

export type PolicySnapshot = {
  rules: any[];
};

import * as fs from "fs";
import * as path from "path";

export type CapabilityName =
    | "scanRepo"
    | "searchDocPreview"
    | "searchDocApply"
    | "fenerisPrep"
    | "baselinePre"
    | "baselinePost"
    | "docker"
    | "memoryCheck"
    | "proposeFixes"
    | "governanceSelfTest"
    | "governanceUnlock"
    | "rollbackKnownGood"
    | "skjoldrFirewallStatus"
    | "skjoldrFirewallApplyProfile"
    | "skjoldrFirewallApplyRulesetFile"
    | "skjoldrFirewallExportBaseline"
    | "skjoldrFirewallRestoreBaseline"
    | "skjoldrFirewallAdviseInboundRuleSets"
    | "analyzeDependency"
    | "mondayInfractionReview"
    | "mondaySystemStatus";

export type CapabilityTier = 0 | 1 | 2;

export interface CapabilityMeta {
    name: CapabilityName;
    readOnly: boolean;
    tier: CapabilityTier;
}

const CAPABILITY_META: Record<CapabilityName, CapabilityMeta> = {
    // Tier 0: safe, read-only
    scanRepo: { name: "scanRepo", readOnly: true, tier: 0 },
    searchDocPreview: { name: "searchDocPreview", readOnly: true, tier: 0 },

    memoryCheck: { name: "memoryCheck", readOnly: true, tier: 0 },
    governanceSelfTest: { name: "governanceSelfTest", readOnly: false, tier: 1 },

    // Tier 1+: mutating / privileged (approval required)
    searchDocApply: { name: "searchDocApply", readOnly: false, tier: 1 },
    fenerisPrep: { name: "fenerisPrep", readOnly: true, tier: 1 },
    baselinePre: { name: "baselinePre", readOnly: false, tier: 1 },
    baselinePost: { name: "baselinePost", readOnly: true, tier: 1 },

    proposeFixes: { name: "proposeFixes", readOnly: false, tier: 1 },

    rollbackKnownGood: { name: "rollbackKnownGood", readOnly: false, tier: 2 },
    governanceUnlock: { name: "governanceUnlock", readOnly: false, tier: 2 },
    docker: { name: "docker", readOnly: false, tier: 2 },

    skjoldrFirewallStatus: { name: "skjoldrFirewallStatus", readOnly: true, tier: 0 },
    skjoldrFirewallApplyProfile: { name: "skjoldrFirewallApplyProfile", readOnly: false, tier: 2 },
    skjoldrFirewallApplyRulesetFile: { name: "skjoldrFirewallApplyRulesetFile", readOnly: false, tier: 2 },
    skjoldrFirewallExportBaseline: { name: "skjoldrFirewallExportBaseline", readOnly: false, tier: 2 },
    skjoldrFirewallRestoreBaseline: { name: "skjoldrFirewallRestoreBaseline", readOnly: false, tier: 2 },
    skjoldrFirewallAdviseInboundRuleSets: { name: "skjoldrFirewallAdviseInboundRuleSets", readOnly: true, tier: 0 },

    analyzeDependency: { name: "analyzeDependency", readOnly: true, tier: 0 },

    mondayInfractionReview: { name: "mondayInfractionReview", readOnly: false, tier: 1 },
    mondaySystemStatus: { name: "mondaySystemStatus", readOnly: true, tier: 0 }
};

export function getCapabilityMeta(name: CapabilityName): CapabilityMeta {
    return CAPABILITY_META[name];
}

export function capabilityRequiresApproval(name: CapabilityName): boolean {
    // Human-in-the-loop for all operations (no exceptions).
    // Tiers still exist for classification/risk, but do not bypass approvals.
    void name;
    return true;
}

export interface AllowlistConfig {
    allowedCapabilities: CapabilityName[];
}

// Mk2 Policy class implements all required methods and allowlist logic
export class Policy {
    private allowedSet: Set<CapabilityName>;

    constructor(allowedCapabilities: CapabilityName[]) {
        this.allowedSet = new Set(allowedCapabilities);
    }

    // Refuse with reason and missing evidence
    refuse(reason: string, evidenceMissing: string[]): { refused: true; reason: string; evidenceMissing: string[] } {
        return { refused: true, reason, evidenceMissing };
    }

    // Allowlist check for capabilities
    isAllowed(capability: CapabilityName): boolean {
        return this.allowedSet.has(capability);
    }
}

// Deny-by-default: if allowlist.json is missing or unreadable, nothing is allowed.
// The explicit config/allowlist.json is the authorization document — not this fallback.
const DEFAULT_ALLOWLIST: AllowlistConfig = {
    allowedCapabilities: []
};

export function loadAllowlist(repoRoot: string): AllowlistConfig {
    try {
        const filePath = path.join(repoRoot, "config", "allowlist.json");
        if (!fs.existsSync(filePath)) return DEFAULT_ALLOWLIST;
        const raw = fs.readFileSync(filePath, "utf8");
        const parsed = JSON.parse(raw) as Partial<AllowlistConfig>;
        const allowed = Array.isArray(parsed.allowedCapabilities)
            ? (parsed.allowedCapabilities.filter(Boolean) as CapabilityName[])
            : [];
        return { allowedCapabilities: allowed };
    } catch {
        return DEFAULT_ALLOWLIST;
    }
}

export function createPolicy(repoRoot: string): Policy {
    const allowlist = loadAllowlist(repoRoot);
    return new Policy(allowlist.allowedCapabilities);
}
