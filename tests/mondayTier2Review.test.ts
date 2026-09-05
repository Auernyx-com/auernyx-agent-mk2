import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { mondayTier2Review } from "../capabilities/mondayTier2Review";

function makeRepoRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mk2-mondaytier2-test-"));
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "test" }));
  return dir;
}

function ctx(repoRoot: string) {
  return { repoRoot, sessionId: "test-session" } as any;
}

function setControlledRiskTolerance(repoRoot: string): void {
  const dir = path.join(repoRoot, ".auernyx", "kintsugi", "policy");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "active.policy.json"), JSON.stringify({ riskTolerance: "CONTROLLED" }));
}

function writeModuleRegistry(repoRoot: string, modules: unknown[]): void {
  fs.mkdirSync(path.join(repoRoot, "config"), { recursive: true });
  fs.writeFileSync(
    path.join(repoRoot, "config", "module-registry.json"),
    JSON.stringify({ schema: "auernyx.module-registry.v1", modules })
  );
}

test("with no capability given, lists status and the known tier2 capabilities (core descriptors present by default)", async () => {
  const result = (await mondayTier2Review(ctx(makeRepoRoot()))) as any;
  assert.equal(result.status, "capability_required");
  assert.ok(result.tier2_capabilities.includes("rollbackKnownGood"));
  assert.ok(result.tier2_capabilities.includes("governanceUnlock"));
  assert.ok(result.tier2_capabilities.includes("docker"));
});

test("an unrecognised capability name is reported as unknown_capability", async () => {
  const result = (await mondayTier2Review(ctx(makeRepoRoot()), { capability: "not-a-real-capability" })) as any;
  assert.equal(result.status, "unknown_capability");
});

test("a real capability below tier 2 is reported as not_tier2, no risk gating applied", async () => {
  const result = (await mondayTier2Review(ctx(makeRepoRoot()), { capability: "scanRepo" })) as any;
  assert.equal(result.status, "not_tier2");
  assert.equal(result.actual_tier, 0);
});

test("a tier 2 capability is blocked when risk tolerance is the default WITHIN_TOLERANCE", async () => {
  const result = (await mondayTier2Review(ctx(makeRepoRoot()), { capability: "rollbackKnownGood" })) as any;
  assert.equal(result.status, "risk_tolerance_insufficient");
  assert.equal(result.risk_tolerance, "WITHIN_TOLERANCE");
  assert.match(result.human_readable, /BLOCKED/);
  assert.match(result.human_readable, /proposeFixes/);
});

test("a tier 2 capability is ready_for_approval once risk tolerance is CONTROLLED, and surfaces the hardcoded core descriptor", async () => {
  const repoRoot = makeRepoRoot();
  setControlledRiskTolerance(repoRoot);

  const result = (await mondayTier2Review(ctx(repoRoot), { capability: "rollbackKnownGood" })) as any;
  assert.equal(result.status, "ready_for_approval");
  assert.equal(result.irreversible, true);
  assert.match(result.human_readable, /Rolls the system back to a known-good snapshot/);
  assert.match(result.human_readable, /confirm: "APPLY"/);
});

test("a tier 2 capability with no descriptor anywhere reports irreversible:null and UNKNOWN reversibility, without crashing", async () => {
  const repoRoot = makeRepoRoot();
  setControlledRiskTolerance(repoRoot);

  // skjoldrFirewallApplyProfile is tier 2 but has no CORE_TIER2_DESCRIPTORS entry
  // and no module registry entry in this test.
  const result = (await mondayTier2Review(ctx(repoRoot), { capability: "skjoldrFirewallApplyProfile" })) as any;
  assert.equal(result.status, "ready_for_approval");
  assert.equal(result.irreversible, null);
  assert.match(result.human_readable, /UNKNOWN/);
});

test("a module registry can supply a descriptor for a tier 2 capability that core doesn't cover", async () => {
  const repoRoot = makeRepoRoot();
  setControlledRiskTolerance(repoRoot);
  writeModuleRegistry(repoRoot, [
    {
      id: "test-module",
      name: "Test Module",
      tier2_capabilities: {
        skjoldrFirewallApplyProfile: {
          action: "Applies a firewall profile.",
          consequence: "Firewall rules change immediately.",
          irreversible: false,
        },
      },
    },
  ]);

  const result = (await mondayTier2Review(ctx(repoRoot), { capability: "skjoldrFirewallApplyProfile" })) as any;
  assert.equal(result.irreversible, false);
  assert.match(result.human_readable, /Applies a firewall profile\./);
});

test("core descriptors always win over a module registry entry for the same capability (registry cannot lie about core risk)", async () => {
  const repoRoot = makeRepoRoot();
  setControlledRiskTolerance(repoRoot);
  // A misconfigured/malicious registry claims rollbackKnownGood is reversible.
  writeModuleRegistry(repoRoot, [
    {
      id: "test-module",
      name: "Test Module",
      tier2_capabilities: {
        rollbackKnownGood: {
          action: "This is a lie.",
          consequence: "This is also a lie.",
          irreversible: false,
        },
      },
    },
  ]);

  const result = (await mondayTier2Review(ctx(repoRoot), { capability: "rollbackKnownGood" })) as any;
  // Core's own irreversible:true must win, not the registry's false claim.
  assert.equal(result.irreversible, true);
  assert.match(result.human_readable, /Rolls the system back to a known-good snapshot/);
  assert.ok(!result.human_readable.includes("This is a lie."));
});
