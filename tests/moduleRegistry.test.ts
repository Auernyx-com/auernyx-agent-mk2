import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  readModuleRegistry,
  moduleRegistryPath,
  getModuleTier2Descriptors,
  getModuleOnboardingQuestions,
  getModuleHealthStatus,
  type ModuleRegistry,
} from "../core/moduleRegistry";

function makeRepoRoot(registry?: ModuleRegistry): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mk2-moduleregistry-test-"));
  if (registry) {
    fs.mkdirSync(path.join(dir, "config"), { recursive: true });
    fs.writeFileSync(moduleRegistryPath(dir), JSON.stringify(registry));
  }
  return dir;
}

test("readModuleRegistry returns an empty registry when no file exists", () => {
  const registry = readModuleRegistry(makeRepoRoot());
  assert.deepEqual(registry, { schema: "auernyx.module-registry.v1", modules: [] });
});

test("readModuleRegistry returns an empty registry for corrupted JSON, rather than throwing", () => {
  const repoRoot = makeRepoRoot();
  fs.mkdirSync(path.join(repoRoot, "config"), { recursive: true });
  fs.writeFileSync(moduleRegistryPath(repoRoot), "{not valid json");
  assert.deepEqual(readModuleRegistry(repoRoot).modules, []);
});

test("readModuleRegistry reads a real registry back correctly", () => {
  const registry: ModuleRegistry = {
    schema: "auernyx.module-registry.v1",
    modules: [
      {
        id: "skjoldr",
        name: "Skjoldr Firewall",
        identifier: "skjoldr-firewall",
        version: "1.0.0",
        attached_at: "2026-08-30T00:00:00Z",
        capabilities: ["skjoldrFirewallStatus"],
        indicator_capability: "skjoldrFirewallStatus",
      },
    ],
  };
  const repoRoot = makeRepoRoot(registry);
  assert.deepEqual(readModuleRegistry(repoRoot), registry);
});

test("getModuleTier2Descriptors merges descriptors from every module that declares one", () => {
  const registry: ModuleRegistry = {
    schema: "auernyx.module-registry.v1",
    modules: [
      {
        id: "a",
        name: "A",
        identifier: "a",
        version: "1.0.0",
        attached_at: "x",
        capabilities: [],
        indicator_capability: "memoryCheck",
        tier2_capabilities: { aAction: { action: "aAction", consequence: "x", irreversible: false } },
      },
      {
        id: "b",
        name: "B",
        identifier: "b",
        version: "1.0.0",
        attached_at: "x",
        capabilities: [],
        indicator_capability: "memoryCheck",
        tier2_capabilities: { bAction: { action: "bAction", consequence: "y", irreversible: true } },
      },
    ],
  };
  const descriptors = getModuleTier2Descriptors(makeRepoRoot(registry));
  assert.deepEqual(Object.keys(descriptors).sort(), ["aAction", "bAction"]);
  assert.equal(descriptors.bAction?.irreversible, true);
});

test("getModuleOnboardingQuestions only returns questions from modules that declare one", () => {
  const registry: ModuleRegistry = {
    schema: "auernyx.module-registry.v1",
    modules: [
      {
        id: "a",
        name: "A",
        identifier: "a",
        version: "1.0.0",
        attached_at: "x",
        capabilities: [],
        indicator_capability: "memoryCheck",
        onboarding: { question_id: "q1", question: "Enable X?", type: "boolean" },
      },
      {
        id: "b",
        name: "B (no onboarding)",
        identifier: "b",
        version: "1.0.0",
        attached_at: "x",
        capabilities: [],
        indicator_capability: "memoryCheck",
      },
    ],
  };
  const questions = getModuleOnboardingQuestions(makeRepoRoot(registry));
  assert.equal(questions.length, 1);
  assert.equal(questions[0].question_id, "q1");
});

test("getModuleHealthStatus reports reachable true only when the indicator capability is actually allowlisted", () => {
  const registry: ModuleRegistry = {
    schema: "auernyx.module-registry.v1",
    modules: [
      {
        id: "healthy",
        name: "Healthy Module",
        identifier: "healthy",
        version: "1.0.0",
        attached_at: "x",
        capabilities: ["scanRepo"],
        indicator_capability: "scanRepo",
      },
      {
        id: "unreachable",
        name: "Unreachable Module",
        identifier: "unreachable",
        version: "1.0.0",
        attached_at: "x",
        capabilities: ["docker"],
        indicator_capability: "docker",
      },
    ],
  };
  const status = getModuleHealthStatus(makeRepoRoot(registry), new Set(["scanRepo"]));
  assert.equal(status.find((s) => s.id === "healthy")?.reachable, true);
  assert.equal(status.find((s) => s.id === "unreachable")?.reachable, false);
});
