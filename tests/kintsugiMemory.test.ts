import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  recordRefusal,
  recordFailure,
  verifyKintsugiIntegrity,
  getKintsugiPolicy,
  policyHash,
  getApproverIdentity,
  makeMfr,
} from "../core/kintsugi/memory";

// First test coverage for kintsugi/memory.ts — the hash-chained Kintsugi
// ledger ("failures are visible, repairs are permanent" per the product's
// own summary). Found and fixed a real, reproducible fork during this pass:
// concurrent recordRefusal/recordFailure calls (routine for a daemon serving
// overlapping requests) could produce multiple records all claiming genesis,
// or multiple records citing the same prev_hash — not from a naive missing-
// lock bug (a lock was added and verified to fully serialize writes) but
// because "find the last record" via filename sort has no true total order
// for records written in the same millisecond. Fixed with an explicit chain
// tip, and validateLedgerChain rewritten to check true prev_hash/record_hash
// linkage instead of trusting file-listing order.

function makeRepoRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mk2-kintsugi-test-"));
}

function refusal(repoRoot: string, action: string) {
  return recordRefusal(repoRoot, {
    system: "test",
    requested_action: action,
    refusal_reason: "NO_AUTHORITY",
    policy_refs: [],
    risk_level: "LOW",
    what_would_be_required: "nothing",
  });
}

test("a single recordRefusal produces a genesis record with no prev_hash, and verifies clean", async () => {
  const repoRoot = makeRepoRoot();
  const rec = await refusal(repoRoot, "first");
  assert.equal(rec.prev_hash, undefined);

  const result = await verifyKintsugiIntegrity(repoRoot);
  assert.equal(result.ok, true);
});

test("sequential records chain correctly: each prev_hash equals the prior record's hash", async () => {
  const repoRoot = makeRepoRoot();
  const a = await refusal(repoRoot, "a");
  const b = await refusal(repoRoot, "b");
  const c = await refusal(repoRoot, "c");

  assert.equal(b.prev_hash, a.record_hash);
  assert.equal(c.prev_hash, b.record_hash);
  assert.equal((await verifyKintsugiIntegrity(repoRoot)).ok, true);
});

test(
  "a burst of concurrent writes (routine for overlapping daemon requests) never forks the chain",
  { timeout: 10000 },
  async () => {
    const repoRoot = makeRepoRoot();
    const N = 30;
    await Promise.all(Array.from({ length: N }, (_, i) => refusal(repoRoot, `action-${i}`)));

    const result = await verifyKintsugiIntegrity(repoRoot);
    assert.equal(result.ok, true, `expected a clean chain, got warnings: ${JSON.stringify(result.warnings)}`);
  }
);

test("tampering with a record's content after the fact is still caught (hash mismatch)", async () => {
  const repoRoot = makeRepoRoot();
  await refusal(repoRoot, "a");
  await refusal(repoRoot, "b");

  const recordsDir = path.join(repoRoot, ".auernyx", "kintsugi", "ledger", "records");
  const files = fs.readdirSync(recordsDir).filter((f) => f.endsWith(".json"));
  const victimPath = path.join(recordsDir, files[0]);
  const victim = JSON.parse(fs.readFileSync(victimPath, "utf8"));
  victim.requested_action = "TAMPERED";
  fs.writeFileSync(victimPath, JSON.stringify(victim));

  const result = await verifyKintsugiIntegrity(repoRoot);
  assert.equal(result.ok, false);
  assert.ok(result.warnings.some((w) => w.includes("hash mismatch")));
});

test("a genuinely forked chain (two records both citing the same prev_hash) is detected, not silently accepted", async () => {
  const repoRoot = makeRepoRoot();
  const first = await refusal(repoRoot, "root");

  // Simulate a fork directly by writing a second record with the same
  // prev_hash as an existing one, bypassing recordLedger's own locking —
  // this tests validateLedgerChain's detection, independent of whether the
  // write path itself can still produce one.
  const recordsDir = path.join(repoRoot, ".auernyx", "kintsugi", "ledger", "records");
  const files = fs.readdirSync(recordsDir).filter((f) => f.endsWith(".json"));
  const existing = JSON.parse(fs.readFileSync(path.join(recordsDir, files[0]), "utf8"));
  const forked = {
    ...existing,
    refusal_id: "forked-record-id",
    requested_action: "forked-branch",
  };
  // Recompute a self-consistent hash for the forged record so this tests
  // fork-detection specifically, not just hash-mismatch detection.
  const crypto = require("crypto");
  function stableStringify(v: any): string {
    if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]";
    if (v && typeof v === "object") {
      return "{" + Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => JSON.stringify(k) + ":" + stableStringify(v[k])).join(",") + "}";
    }
    return JSON.stringify(v);
  }
  const { record_hash, ...withoutHash } = forked;
  forked.record_hash = crypto.createHash("sha256").update(stableStringify({ ...withoutHash, record_hash: undefined })).digest("hex");
  fs.writeFileSync(path.join(recordsDir, "99999999_forked-record-id.json"), JSON.stringify(forked));

  const result = await verifyKintsugiIntegrity(repoRoot);
  assert.equal(result.ok, false);
  assert.ok(result.warnings.some((w) => w.toLowerCase().includes("fork")));
});

test("getKintsugiPolicy returns sane defaults when no policy file exists", () => {
  const policy = getKintsugiPolicy(makeRepoRoot());
  assert.equal(policy.riskTolerance, "WITHIN_TOLERANCE");
  assert.equal(policy.allowRollback, true);
});

test("policyHash is deterministic for identical policy content", () => {
  const p1 = getKintsugiPolicy(makeRepoRoot());
  const p2 = getKintsugiPolicy(makeRepoRoot());
  assert.equal(policyHash(p1), policyHash(p2));
});

test("getApproverIdentity prefers config over kintsugi policy over OS username", () => {
  const repoRoot = makeRepoRoot();
  fs.mkdirSync(path.join(repoRoot, "config"), { recursive: true });
  fs.writeFileSync(
    path.join(repoRoot, "config", "auernyx.config.json"),
    JSON.stringify({ governance: { approverIdentity: "Configured Identity" } })
  );
  assert.equal(getApproverIdentity(repoRoot), "Configured Identity");
});

test("getApproverIdentity falls back to the OS username when nothing is configured", () => {
  const identity = getApproverIdentity(makeRepoRoot());
  assert.equal(typeof identity, "string");
  assert.ok(identity.length > 0);
});

test("recordFailure normalizes record_kind to MFR by default", async () => {
  const repoRoot = makeRepoRoot();
  const rec = await recordFailure(
    repoRoot,
    makeMfr({
      system: "test",
      failure_type: "logic",
      trigger: "test trigger",
      inputs_snapshot: "x",
      pre_state: "x",
      post_state: "x",
      recovery_action: "none",
      authorized_by: "test",
    })
  );
  assert.equal((rec as any).record_kind, "MFR");
});
