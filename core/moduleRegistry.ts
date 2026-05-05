// Module registry for Mk2 — the single attachment point for every module that joins the trunk.
// Drives onboarding questions, Tier 2 briefings, and branch health checks automatically.
//
// NOTE: This file is intentionally outside the governance hash (which covers only
// allowlist.json and auernyx.config.json). The allowlist remains the authorization
// document — capabilities cannot run unless they are in the allowlist regardless of
// registry status. The registry is metadata, not authorization.

import * as fs from "fs";
import * as path from "path";
import type { CapabilityName } from "./policy";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ModuleTier2Descriptor {
    action: string;
    consequence: string;
    irreversible: boolean;
}

export interface ModuleOnboardingQuestion {
    question_id: string;
    question: string;
    type: "boolean" | "string" | "enum";
    options?: string[];
}

export interface ModuleRegistryEntry {
    id: string;
    name: string;
    identifier: string;
    version: string;
    attached_at: string;
    capabilities: CapabilityName[];
    // The single capability that proves this module is reachable.
    // Health check: if indicator_capability is missing from the allowlist, branch is OUT_OF_TOLERANCE.
    indicator_capability: CapabilityName;
    // Tier 2 descriptors for this module's high-risk capabilities only.
    // Core capability descriptors (rollback, governanceUnlock, docker) are hardcoded in
    // mondayTier2Review and cannot be overridden by registry entries.
    tier2_capabilities?: Partial<Record<string, ModuleTier2Descriptor>>;
    // Onboarding question for this module — shown in Phase 2 when the module is registered.
    onboarding?: ModuleOnboardingQuestion;
}

export interface ModuleRegistry {
    schema: "auernyx.module-registry.v1";
    modules: ModuleRegistryEntry[];
}

// ─── Read ─────────────────────────────────────────────────────────────────────

const EMPTY_REGISTRY: ModuleRegistry = { schema: "auernyx.module-registry.v1", modules: [] };

export function moduleRegistryPath(repoRoot: string): string {
    return path.join(repoRoot, "config", "module-registry.json");
}

export function readModuleRegistry(repoRoot: string): ModuleRegistry {
    const p = moduleRegistryPath(repoRoot);
    try {
        if (!fs.existsSync(p)) return EMPTY_REGISTRY;
        return JSON.parse(fs.readFileSync(p, "utf8")) as ModuleRegistry;
    } catch {
        return EMPTY_REGISTRY;
    }
}

// ─── Consumers ────────────────────────────────────────────────────────────────

// Returns Tier 2 descriptors from all registered modules.
// These are merged with (and cannot override) the hardcoded core descriptors in mondayTier2Review.
export function getModuleTier2Descriptors(repoRoot: string): Partial<Record<string, ModuleTier2Descriptor>> {
    const registry = readModuleRegistry(repoRoot);
    const result: Partial<Record<string, ModuleTier2Descriptor>> = {};
    for (const m of registry.modules) {
        if (m.tier2_capabilities) Object.assign(result, m.tier2_capabilities);
    }
    return result;
}

// Returns the onboarding question for each registered module that has one.
export function getModuleOnboardingQuestions(repoRoot: string): ModuleOnboardingQuestion[] {
    const registry = readModuleRegistry(repoRoot);
    return registry.modules.filter(m => m.onboarding).map(m => m.onboarding!);
}

// Returns health status per registered module: is the indicator capability in the allowlist?
export function getModuleHealthStatus(
    repoRoot: string,
    allowedSet: Set<string>
): Array<{ id: string; name: string; indicator_capability: CapabilityName; reachable: boolean }> {
    const registry = readModuleRegistry(repoRoot);
    return registry.modules.map(m => ({
        id: m.id,
        name: m.name,
        indicator_capability: m.indicator_capability,
        reachable: allowedSet.has(m.indicator_capability)
    }));
}
