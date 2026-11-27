import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { createRouter } from "../core/router";
import { createPolicy } from "../core/policy";

// 2026-11-27 Kintsugi fail-closed plan, step 3. The router's only use of
// riskTolerance was the Tier 2 gate (`!== "CONTROLLED"`), so FAILED_CLOSED
// behaved exactly like WITHIN_TOLERANCE: every Tier 0 and Tier 1 capability,
// writes included, still ran. Justin's decision: FAILED_CLOSED behaves like
// the governance lock. Only memoryCheck, governanceSelfTest and
// governanceUnlock run; everything else is refused, read-only included. An
// unknown riskTolerance value counts as FAILED_CLOSED, never looser.

const CAPS = ["memoryCheck", "governanceSelfTest", "governanceUnlock", "proposeFixes", "searchDocApply", "scanRepo"];

function makeTempRepoRoot(riskTolerance?: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mk2-router-failedclosed-test-"));
  fs.mkdirSync(path.join(dir, "config"), { recursive: true });
  fs.writeFileSync(path.join(dir, "config", "allowlist.json"), JSON.stringify({ allowedCapabilities: CAPS }));
  fs.writeFileSync(
    path.join(dir, "config", "auernyx.config.json"),
    JSON.stringify({ governance: { approverIdentity: "Test Approver" }, writeEnabled: true })
  );
  if (riskTolerance !== undefined) {
    const policyDir = path.join(dir, ".auernyx", "kintsugi", "policy");
    fs.mkdirSync(policyDir, { recursive: true });
    fs.writeFileSync(path.join(policyDir, "active.policy.json"), JSON.stringify({ riskTolerance }));
  }
  return dir;
}

const approval = { approvedBy: "human" as const, at: new Date().toISOString(), reason: "test", identity: "Test Approver" };

function makeRouter(repoRoot: string) {
  const stubs = Object.fromEntries(CAPS.map((name) => [name, async () => ({ ok: true, ran: name })]));
  return createRouter(createPolicy(repoRoot), stubs as any);
}

function ctx(repoRoot: string) {
  return { repoRoot, sessionId: "test-session", execution: { planId: "p1", stepId: "s1" } } as any;
}

for (const tolerance of ["FAILED_CLOSED", "banana"]) {
  for (const capability of ["proposeFixes", "searchDocApply", "scanRepo"]) {
    test(`riskTolerance ${tolerance}: ${capability} is refused`, async () => {
      const repoRoot = makeTempRepoRoot(tolerance);
      await assert.rejects(
        () => makeRouter(repoRoot).run(capability as any, ctx(repoRoot), undefined, approval),
        /kintsugi_failed_closed/
      );
    });
  }

  for (const capability of ["memoryCheck", "governanceSelfTest", "governanceUnlock"]) {
    test(`riskTolerance ${tolerance}: ${capability} still runs (same list as the governance lock)`, async () => {
      const repoRoot = makeTempRepoRoot(tolerance);
      const result = (await makeRouter(repoRoot).run(capability as any, ctx(repoRoot), undefined, approval)) as any;
      assert.equal(result.ran, capability);
    });
  }
}

test("the refusal names the riskTolerance value it found", async () => {
  const repoRoot = makeTempRepoRoot("banana");
  await assert.rejects(
    () => makeRouter(repoRoot).run("scanRepo" as any, ctx(repoRoot), undefined, approval),
    /kintsugi_failed_closed: riskTolerance="banana"/
  );
});

test("WITHIN_TOLERANCE (the default): Tier 0 and Tier 1 capabilities run as before", async () => {
  const repoRoot = makeTempRepoRoot();
  for (const capability of ["proposeFixes", "searchDocApply", "scanRepo"]) {
    const result = (await makeRouter(repoRoot).run(capability as any, ctx(repoRoot), undefined, approval)) as any;
    assert.equal(result.ran, capability);
  }
});
