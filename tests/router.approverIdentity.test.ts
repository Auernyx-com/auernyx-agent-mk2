import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { createRouter } from "../core/router";
import { createPolicy } from "../core/policy";

// Regression coverage for a fail-open default found in the same 2026-09-05
// top-down governance review as router.governanceUnlock.test.ts:
// governance.approverIdentity defaulted to "", and the router treated an
// empty expected identity as "identity checking not required" rather than
// "no approver configured yet." That let any syntactically-valid approval
// object (no proof a human actually approved anything) through for every
// non-readonly capability whenever this one config field was left unset —
// the opposite of the system's own "fail-closed always, never default open"
// invariant.

function makeTempRepoRoot(approverIdentity: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mk2-router-identity-test-"));
  fs.mkdirSync(path.join(dir, "config"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "config", "allowlist.json"),
    JSON.stringify({ allowedCapabilities: ["governanceSelfTest", "memoryCheck"] })
  );
  fs.writeFileSync(
    path.join(dir, "config", "auernyx.config.json"),
    JSON.stringify({
      governance: { approverIdentity },
      writeEnabled: true
    })
  );
  return dir;
}

function makeCtx(repoRoot: string) {
  return {
    repoRoot,
    sessionId: "test-session",
    execution: { planId: "p1", stepId: "s1" }
  };
}

const structurallyValidApproval = {
  approvedBy: "human" as const,
  at: new Date().toISOString(),
  reason: "test"
  // deliberately no identity field — this is exactly what a caller with no
  // real human-approval channel could trivially construct on their own.
};

test("unconfigured approverIdentity fails closed for non-readonly capabilities", async () => {
  const repoRoot = makeTempRepoRoot(""); // the actual shipped default

  const router = createRouter(createPolicy(repoRoot), {
    governanceSelfTest: async () => ({ ok: true })
  } as any);

  await assert.rejects(
    () => router.run("governanceSelfTest" as any, makeCtx(repoRoot) as any, undefined, structurallyValidApproval),
    /approverIdentity not configured/
  );
});

test("configured approverIdentity still requires a matching identity", async () => {
  const repoRoot = makeTempRepoRoot("Real Approver");

  const router = createRouter(createPolicy(repoRoot), {
    governanceSelfTest: async () => ({ ok: true })
  } as any);

  await assert.rejects(
    () => router.run("governanceSelfTest" as any, makeCtx(repoRoot) as any, undefined, structurallyValidApproval),
    /no_authority/
  );

  const result = await router.run(
    "governanceSelfTest" as any,
    makeCtx(repoRoot) as any,
    undefined,
    { ...structurallyValidApproval, identity: "Real Approver" }
  );
  assert.deepEqual(result, { ok: true });
});

test("read-only capabilities never required identity — unaffected by this fix", async () => {
  const repoRoot = makeTempRepoRoot(""); // unconfigured, same as the fail-open case above

  const router = createRouter(createPolicy(repoRoot), {
    memoryCheck: async () => ({ ok: true })
  } as any);

  const result = await router.run(
    "memoryCheck" as any,
    makeCtx(repoRoot) as any,
    undefined,
    structurallyValidApproval
  );
  assert.deepEqual(result, { ok: true });
});
