import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { createRouter } from "../core/router";
import { createPolicy } from "../core/policy";
import { writeGovernanceLock } from "../core/governanceLock";
import { governanceUnlock } from "../capabilities/governanceUnlock";

// Regression coverage for a real deadlock found in a 2026-09-05 top-down
// governance review: governanceUnlock is tier 2, so before the fix it was
// subject to the same "risk tolerance must already be CONTROLLED" gate as
// every other tier-2 capability. But proposeFixes — the only capability that
// can elevate risk tolerance to CONTROLLED — is not on the governance-lock
// allowlist, so it can never run while locked either. A lock tripped at the
// default WITHIN_TOLERANCE risk tolerance (the normal case) had no capability
// -based way out at all. These tests pin the fix: governanceUnlock must be
// reachable under exactly that condition, and the exemption must stay
// narrowly scoped — every other tier-2 capability must remain gated.

function makeTempRepoRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mk2-router-test-"));
  fs.mkdirSync(path.join(dir, "config"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "config", "allowlist.json"),
    JSON.stringify({ allowedCapabilities: ["governanceUnlock", "docker"] })
  );
  fs.writeFileSync(
    path.join(dir, "config", "auernyx.config.json"),
    JSON.stringify({
      governance: { approverIdentity: "Test Approver" },
      writeEnabled: true
      // governance.riskTolerance intentionally omitted — defaults to
      // WITHIN_TOLERANCE, the exact state that produced the deadlock.
    })
  );
  return dir;
}

const approval = {
  approvedBy: "human" as const,
  at: new Date().toISOString(),
  reason: "test",
  identity: "Test Approver"
};

test("governanceUnlock can clear a lock at the default WITHIN_TOLERANCE risk tolerance", async () => {
  const repoRoot = makeTempRepoRoot();
  writeGovernanceLock(repoRoot, { locked: true, reason: "test lock" });

  const router = createRouter(createPolicy(repoRoot), {
    governanceUnlock
  } as any);

  const ctx = {
    repoRoot,
    sessionId: "test-session",
    execution: { planId: "p1", stepId: "s1" }
  };

  const result = (await router.run("governanceUnlock" as any, ctx as any, undefined, approval)) as {
    ok: boolean;
  };

  assert.equal(result.ok, true);
});

test("other tier-2 capabilities stay gated by risk tolerance — the exemption is not a blanket loosening", async () => {
  const repoRoot = makeTempRepoRoot();
  // Deliberately left unlocked: this isolates the risk-tolerance gate itself
  // (governanceUnlock's own lock-allowlist entry would otherwise mask it).

  const router = createRouter(createPolicy(repoRoot), {
    docker: async () => ({ ok: true })
  } as any);

  const ctx = {
    repoRoot,
    sessionId: "test-session",
    execution: { planId: "p1", stepId: "s1" }
  };

  await assert.rejects(
    () => router.run("docker" as any, ctx as any, undefined, approval),
    /risk_tolerance_insufficient/
  );
});

test("governanceUnlock is still blocked while locked if ledger integrity fails", async () => {
  const repoRoot = makeTempRepoRoot();
  writeGovernanceLock(repoRoot, { locked: true, reason: "test lock" });
  fs.mkdirSync(path.join(repoRoot, "logs"), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, "logs", "ledger.ndjson"), "not json\n");

  const router = createRouter(createPolicy(repoRoot), {
    governanceUnlock
  } as any);

  const ctx = {
    repoRoot,
    sessionId: "test-session",
    execution: { planId: "p1", stepId: "s1" }
  };

  const result = (await router.run("governanceUnlock" as any, ctx as any, undefined, approval)) as {
    ok: boolean;
    error?: string;
  };

  assert.equal(result.ok, false);
  assert.equal(result.error, "AUDIT_INVARIANT_VIOLATION");
});
