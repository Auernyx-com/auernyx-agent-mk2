import * as fs from "fs";
import * as path from "path";

export type CapabilityName =
    | "scanRepo"
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
    | "skjoldrFirewallRestoreBaseline";

export type CapabilityTier = 0 | 1 | 2;

export interface CapabilityMeta {
    name: CapabilityName;
    readOnly: boolean;
    tier: CapabilityTier;
}

const CAPABILITY_META: Record<CapabilityName, CapabilityMeta> = {
    // Tier 0: safe, read-only
    scanRepo: { name: "scanRepo", readOnly: true, tier: 0 },

    memoryCheck: { name: "memoryCheck", readOnly: true, tier: 0 },
    governanceSelfTest: { name: "governanceSelfTest", readOnly: false, tier: 1 },

    // Tier 1+: mutating / privileged (approval required)
    fenerisPrep: { name: "fenerisPrep", readOnly: false, tier: 1 },
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
    skjoldrFirewallRestoreBaseline: { name: "skjoldrFirewallRestoreBaseline", readOnly: false, tier: 2 }
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

export interface Policy {
    isAllowed(capability: CapabilityName): boolean;
}

const DEFAULT_ALLOWLIST: AllowlistConfig = {
    allowedCapabilities: [
        "scanRepo",
        "fenerisPrep",
        "baselinePre",
        "baselinePost",
        "memoryCheck",
        "proposeFixes",
        "governanceSelfTest",
        "governanceUnlock",
        "rollbackKnownGood",
        "skjoldrFirewallStatus",
        "skjoldrFirewallApplyProfile",
        "skjoldrFirewallApplyRulesetFile",
        "skjoldrFirewallExportBaseline",
        "skjoldrFirewallRestoreBaseline",
        "docker"
    ]
};

export function loadAllowlist(repoRoot: string): AllowlistConfig {
    try {
        const filePath = path.join(repoRoot, "config", "allowlist.json");
        if (!fs.existsSync(filePath)) return DEFAULT_ALLOWLIST;
        const raw = fs.readFileSync(filePath, "utf8");
        const parsed = JSON.parse(raw) as Partial<AllowlistConfig>;
        const allowed = Array.isArray(parsed.allowedCapabilities)
            ? (parsed.allowedCapabilities.filter(Boolean) as CapabilityName[])
            : DEFAULT_ALLOWLIST.allowedCapabilities;
        return { allowedCapabilities: allowed };
    } catch {
        return DEFAULT_ALLOWLIST;
    }
}

export function createPolicy(repoRoot: string): Policy {
    const allowlist = loadAllowlist(repoRoot);
    const allowedSet = new Set(allowlist.allowedCapabilities);

    return {
        isAllowed(capability: CapabilityName) {
            return allowedSet.has(capability);
        }
    };
}
