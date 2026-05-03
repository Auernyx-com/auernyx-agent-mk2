// Ghost (Watcher and Drift Observer) — independent threat model and dual-witness verification.
// Ghost observes only. No writes, no side effects. (GHOST.NO_SIDE_EFFECTS: hard_refusal)
// Ghost's threat model is derived from Ghost's own domain knowledge — NOT copied from config.
// Cross-verified against Mnema's authoritative list (config.governance.protectedPaths) at self-test time.

// Ghost independently identifies these as critical systems that must always be protected.
// If Mnema's list drops any of these, Ghost catches it. If Mnema's list adds an unknown path,
// Ghost flags it for HIL review — it may be valid, but it is not within Ghost's known threat model.
const GHOST_THREAT_MODEL: ReadonlyArray<{ path: string; label: string; critical: boolean }> = [
    {
        path: ".auernyx/kintsugi/ledger/records",
        label: "Kintsugi audit ledger records",
        critical: true,
    },
    {
        path: ".auernyx/kintsugi/policy/history",
        label: "policy history snapshots",
        critical: true,
    },
    {
        path: ".auernyx/kintsugi/active.policy.json",
        label: "active policy file",
        critical: true,
    },
];

export type WitnessDeviation = {
    path: string;
    label: string;
    critical: boolean;
    inGhostThreatModel: boolean;
    inMnemaList: boolean;
};

export type GhostVerificationResult = {
    ok: boolean;
    deviations: WitnessDeviation[];
    criticalDeviations: WitnessDeviation[];
};

function normalizeRel(p: string): string {
    return String(p).replace(/\\/g, "/").replace(/^\/+/, "").trim().toLowerCase();
}

function mnemaCovers(mnemaList: string[], targetRel: string): boolean {
    const target = normalizeRel(targetRel);
    for (const entry of mnemaList) {
        const norm = normalizeRel(entry);
        if (target === norm || target.startsWith(norm + "/")) return true;
        if (norm === target || norm.startsWith(target + "/")) return true;
    }
    return false;
}

function ghostKnows(targetRel: string): boolean {
    const target = normalizeRel(targetRel);
    for (const threat of GHOST_THREAT_MODEL) {
        const norm = normalizeRel(threat.path);
        if (target === norm || target.startsWith(norm + "/") || norm.startsWith(target + "/")) return true;
    }
    return false;
}

// Pure function — Ghost observes and returns findings. Caller handles emission and response.
export function runGhostVerification(mnemaProtectedPaths: string[]): GhostVerificationResult {
    const deviations: WitnessDeviation[] = [];

    // Direction 1: Ghost's threat model → Mnema's list.
    // Every path Ghost identifies as critical must also appear in Mnema's authoritative list.
    // Missing = Mnema is not tracking something Ghost knows is a threat. Critical by definition.
    for (const threat of GHOST_THREAT_MODEL) {
        if (!mnemaCovers(mnemaProtectedPaths, threat.path)) {
            deviations.push({
                path: threat.path,
                label: threat.label,
                critical: threat.critical,
                inGhostThreatModel: true,
                inMnemaList: false,
            });
        }
    }

    // Direction 2: Mnema's list → Ghost's threat model.
    // Every path Mnema claims to protect should be recognizable to Ghost.
    // Unknown path = Mnema is protecting something outside Ghost's threat model.
    // Non-critical: may be a valid custom addition, but requires HIL confirmation.
    for (const mnemaPath of mnemaProtectedPaths) {
        if (!ghostKnows(mnemaPath)) {
            deviations.push({
                path: mnemaPath,
                label: mnemaPath,
                critical: false,
                inGhostThreatModel: false,
                inMnemaList: true,
            });
        }
    }

    const criticalDeviations = deviations.filter((d) => d.critical);
    return {
        ok: deviations.length === 0,
        deviations,
        criticalDeviations,
    };
}
