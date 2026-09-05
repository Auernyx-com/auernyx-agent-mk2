import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { rollbackKnownGood } from "../capabilities/rollbackKnownGood";
import { recordKnownGoodSnapshot } from "../core/kintsugi/knownGood";
import { snapshotPolicyAndActivate, getKintsugiPolicy } from "../core/kintsugi/memory";
import { GovernanceRefusalError } from "../core/governanceRefusal";

// First test coverage for rollbackKnownGood.ts — a tier-2 capability with
// several independent integrity gates (policy allowRollback, ledger
// integrity, window/depth, ledger_head_hash chain-membership, policy
// snapshot hash x2, typed-APPLY approval for CONTROLLED risk) that had none.

function makeRepoRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mk2-rollback-test-"));
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "test" }));
  return dir;
}

function makeCtx(repoRoot: string, approval?: unknown) {
  return { repoRoot, sessionId: "test-session", approval } as any;
}

// Builds a real, valid Known Good snapshot the same way baselinePre.ts does
// — via the real recordKnownGoodSnapshot function, not a hand-rolled fixture
// — so these tests exercise the actual on-disk shape a real snapshot has.
async function makeRealSnapshot(repoRoot: string): Promise<string> {
  const policy = getKintsugiPolicy(repoRoot);
  const { snapshotPath, hash } = await snapshotPolicyAndActivate(repoRoot, policy, {
    suggestionId: "test-baseline",
    reason: "test baseline",
    approvedBy: "Test Approver",
    riskLevel: "CONTROLLED",
    blastRadius: ["kintsugi-policy"],
  });
  const entry = await recordKnownGoodSnapshot(repoRoot, {
    policySnapshotPath: snapshotPath,
    policyHash: hash,
    approvedBy: "Test Approver",
    reason: "test baseline",
  });
  return entry.kgs_id;
}

test("list returns entries and the active rollback policy, without requiring allowRollback", async () => {
  const repoRoot = makeRepoRoot();
  const kgsId = await makeRealSnapshot(repoRoot);

  const result = (await rollbackKnownGood(makeCtx(repoRoot), { action: "list" })) as any;
  assert.equal(result.entries.some((e: any) => e.kgs_id === kgsId), true);
  assert.equal(typeof result.policy.allowRollback, "boolean");
});

test("restore refuses when allowRollback is disabled by policy", async () => {
  const repoRoot = makeRepoRoot();
  const kgsId = await makeRealSnapshot(repoRoot);
  const policy = getKintsugiPolicy(repoRoot);
  await snapshotPolicyAndActivate(
    repoRoot,
    { ...policy, allowRollback: false },
    { suggestionId: "disable", reason: "disable rollback", approvedBy: "x", riskLevel: "CONTROLLED", blastRadius: [] }
  );

  await assert.rejects(
    () => rollbackKnownGood(makeCtx(repoRoot, { confirm: "APPLY" }), { action: "restore", kgsId }),
    (err: unknown) => err instanceof GovernanceRefusalError && err.refusal.refusalReason === "POLICY_CONFLICT"
  );
});

test("restore refuses without typed APPLY approval (CONTROLLED risk class is the default)", async () => {
  const repoRoot = makeRepoRoot();
  const kgsId = await makeRealSnapshot(repoRoot);

  await assert.rejects(
    () => rollbackKnownGood(makeCtx(repoRoot /* no approval */), { action: "restore", kgsId }),
    (err: unknown) => err instanceof GovernanceRefusalError && err.refusal.refusalReason === "HIL_REQUIRED"
  );
});

test("restore refuses an unknown kgsId", async () => {
  const repoRoot = makeRepoRoot();
  await makeRealSnapshot(repoRoot);

  await assert.rejects(
    () => rollbackKnownGood(makeCtx(repoRoot, { confirm: "APPLY" }), { action: "restore", kgsId: "KGS-does-not-exist" }),
    (err: unknown) => err instanceof GovernanceRefusalError && err.refusal.refusalReason === "PRECONDITIONS_NOT_MET"
  );
});

test("restore refuses a snapshot whose policy content was tampered with after the fact", async () => {
  // rollbackKnownGood has its own policy-snapshot-hash re-check, but
  // verifyKintsugiIntegrity's own validatePolicySnapshots ALREADY catches
  // this same tampering first (it's called earlier, gated by
  // rollbackRequiresIntegrityPass, which defaults to true) — legitimate
  // defense-in-depth, not a bug, but it means testing rollbackKnownGood's
  // own re-check specifically requires disabling that earlier gate so this
  // test actually exercises the later check rather than the earlier one.
  const repoRoot = makeRepoRoot();
  const kgsId = await makeRealSnapshot(repoRoot);

  const policy = getKintsugiPolicy(repoRoot);
  await snapshotPolicyAndActivate(
    repoRoot,
    { ...policy, rollbackRequiresIntegrityPass: false },
    { suggestionId: "disable-integrity-gate", reason: "test isolation", approvedBy: "x", riskLevel: "CONTROLLED", blastRadius: [] }
  );

  const entriesDir = path.join(repoRoot, ".auernyx", "kintsugi", "known_good", "entries");
  const entryFile = fs.readdirSync(entriesDir)[0];
  const entry = JSON.parse(fs.readFileSync(path.join(entriesDir, entryFile), "utf8"));
  const snapshot = JSON.parse(fs.readFileSync(entry.policy_snapshot_path, "utf8"));
  snapshot.policy.riskTolerance = "CONTROLLED"; // tampered, policy_hash left stale
  fs.writeFileSync(entry.policy_snapshot_path, JSON.stringify(snapshot));

  await assert.rejects(
    () => rollbackKnownGood(makeCtx(repoRoot, { confirm: "APPLY" }), { action: "restore", kgsId }),
    (err: unknown) =>
      err instanceof GovernanceRefusalError &&
      err.refusal.refusalReason === "AUDIT_INVARIANT_VIOLATION" &&
      err.refusal.notes === "Policy snapshot hash mismatch."
  );
});

test("restore refuses when ledger integrity is broken and rollbackRequiresIntegrityPass is set (the default)", async () => {
  const repoRoot = makeRepoRoot();
  const kgsId = await makeRealSnapshot(repoRoot);

  // Corrupt the ledger directly.
  const recordsDir = path.join(repoRoot, ".auernyx", "kintsugi", "ledger", "records");
  const files = fs.readdirSync(recordsDir).filter((f) => f.endsWith(".json"));
  const victim = JSON.parse(fs.readFileSync(path.join(recordsDir, files[0]), "utf8"));
  victim.trigger = "TAMPERED";
  fs.writeFileSync(path.join(recordsDir, files[0]), JSON.stringify(victim));

  await assert.rejects(
    () => rollbackKnownGood(makeCtx(repoRoot, { confirm: "APPLY" }), { action: "restore", kgsId }),
    (err: unknown) => err instanceof GovernanceRefusalError && err.refusal.refusalReason === "AUDIT_INVARIANT_VIOLATION"
  );
});

test("a fully valid restore succeeds, records the change, and reports config restore status", async () => {
  const repoRoot = makeRepoRoot();
  const kgsId = await makeRealSnapshot(repoRoot);

  const result = (await rollbackKnownGood(makeCtx(repoRoot, { confirm: "APPLY" }), {
    action: "restore",
    kgsId,
  })) as any;

  assert.equal(result.kgsId, kgsId);
  assert.equal(typeof result.restoredPolicyHash, "string");
  // No config/allowlist.json snapshot exists in this test's Known Good entry
  // (baselinePre.ts's real flow snapshots config too; this test only built
  // the policy side) — restore should report that honestly, not silently.
  assert.equal(result.configRestored, false);
  assert.ok(result.configRestoreWarning);
});
