import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { proposeFixes } from "../capabilities/proposeFixes";
import { GovernanceRefusalError } from "../core/governanceRefusal";
import { getKintsugiPolicy } from "../core/kintsugi/memory";

// First test coverage for proposeFixes.ts. Found and fixed a real, serious
// bug while writing these: the typed-APPLY confirmation requirement was
// inverted. `riskLevel = loosening ? "ELEVATED" : "CONTROLLED"`, but the
// confirmation check fired on `riskLevel === "CONTROLLED"` — the *non*-
// loosening case — so every loosening change (disabling the human
// confirmation gate, disabling rollback's integrity requirement, etc.)
// sailed through with zero confirmation, while safe tightening changes were
// the ones blocked without it. Verified directly before fixing: applying
// "disable-confirmArtifactWrites" succeeded with ok:true and no
// approval.confirm at all.

function makeRepoRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mk2-proposefixes-test-"));
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "test" }));
  return dir;
}

function ctx(repoRoot: string, approval?: unknown) {
  return { repoRoot, sessionId: "test-session", approval } as any;
}

const validApproval = { approvedBy: "human" as const, at: new Date().toISOString(), reason: "test" };

test("with no apply flag, lists suggestions for a default (WITHIN_TOLERANCE) policy without changing anything", async () => {
  const repoRoot = makeRepoRoot();
  const result = (await proposeFixes(ctx(repoRoot))) as any;

  assert.equal(result.ok, true);
  const ids = result.suggestions.map((s: any) => s.id);
  assert.ok(ids.includes("enable-riskTolerance-controlled"));
  assert.ok(ids.includes("disable-confirmArtifactWrites"));
  assert.ok(ids.includes("enable-strictPreflightForArtifactWrites"));
});

test("a healthy policy with no applicable loosening suggestions doesn't propose disabling the integrity-pass requirement", async () => {
  const repoRoot = makeRepoRoot();
  const result = (await proposeFixes(ctx(repoRoot))) as any;
  // Fresh repo, no ledger at all -> verifyKintsugiIntegrity is trivially ok,
  // so the "disable-rollbackRequiresIntegrityPass" suggestion should NOT appear.
  assert.ok(!result.suggestions.some((s: any) => s.id === "disable-rollbackRequiresIntegrityPass"));
});

test("apply requires a suggestionId, and rejects an unknown one", async () => {
  const repoRoot = makeRepoRoot();
  await assert.rejects(() => proposeFixes(ctx(repoRoot, validApproval), { apply: true }), /suggestionId is required/);
  await assert.rejects(
    () => proposeFixes(ctx(repoRoot, validApproval), { apply: true, suggestionId: "not-a-real-suggestion" }),
    /Unknown\/unsupported suggestionId/
  );
});

test("a LOOSENING change is refused without typed APPLY confirmation (the fix)", async () => {
  const repoRoot = makeRepoRoot();
  await assert.rejects(
    () =>
      proposeFixes(ctx(repoRoot, { ...validApproval /* no confirm: 'APPLY' */ }), {
        apply: true,
        suggestionId: "disable-confirmArtifactWrites",
      }),
    (err: unknown) => err instanceof GovernanceRefusalError && err.refusal.refusalReason === "LOOSENING_REQUIRES_CONTROLLED_APPROVAL"
  );
});

test("a LOOSENING change succeeds once typed APPLY confirmation is actually given", async () => {
  const repoRoot = makeRepoRoot();
  const result = (await proposeFixes(ctx(repoRoot, { ...validApproval, confirm: "APPLY" }), {
    apply: true,
    suggestionId: "disable-confirmArtifactWrites",
  })) as any;

  assert.equal(result.ok, true);
  assert.equal(result.riskLevel, "ELEVATED");
  const after = getKintsugiPolicy(repoRoot);
  assert.equal(after.confirmArtifactWrites, false);
});

test("a non-loosening (tightening) change does NOT require typed APPLY confirmation", async () => {
  const repoRoot = makeRepoRoot();
  // No confirm: "APPLY" — a tightening change should not need it.
  const result = (await proposeFixes(ctx(repoRoot, validApproval), {
    apply: true,
    suggestionId: "enable-strictPreflightForArtifactWrites",
  })) as any;

  assert.equal(result.ok, true);
  assert.equal(result.riskLevel, "CONTROLLED");
  const after = getKintsugiPolicy(repoRoot);
  assert.equal(after.strictPreflightForArtifactWrites, true);
});

test("enabling riskTolerance CONTROLLED is itself classified as a loosening change requiring confirmation", async () => {
  const repoRoot = makeRepoRoot();
  await assert.rejects(
    () => proposeFixes(ctx(repoRoot, validApproval), { apply: true, suggestionId: "enable-riskTolerance-controlled" }),
    (err: unknown) => err instanceof GovernanceRefusalError
  );

  const result = (await proposeFixes(ctx(repoRoot, { ...validApproval, confirm: "APPLY" }), {
    apply: true,
    suggestionId: "enable-riskTolerance-controlled",
  })) as any;
  assert.equal(result.ok, true);
  assert.equal(getKintsugiPolicy(repoRoot).riskTolerance, "CONTROLLED");
});
