import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { recordKnownGoodSnapshot, listKnownGoodSnapshotsWithPaths } from "../core/kintsugi/knownGood";

// First test coverage for core/kintsugi/knownGood.ts — note this is a
// distinct module from core/knownGood.ts (both exist; the rollback
// capability's own tests exercise this one via the real recordKnownGoodSnapshot
// path, this file adds direct unit coverage plus the regression pinning the
// created_by fix below.
//
// Found and fixed while reading this module: created_by was stored as
// makeSnapshotHash(approvedBy) — a one-way hash of the identity — while the
// identical field in the sibling snapshot function one file over
// (writePolicySnapshotAndActivate, core/kintsugi/memory.ts) stores it in
// plain text. Nothing anywhere read created_by back for comparison, so this
// wasn't a deliberate anonymization; it silently destroyed the "who created
// this" audit trail for every Known Good snapshot.

function makeRepoRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mk2-kintsugi-knowngood-test-"));
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "test" }));
  return dir;
}

test("recordKnownGoodSnapshot stores the approver identity in plain text (the fix)", async () => {
  const repoRoot = makeRepoRoot();
  const entry = await recordKnownGoodSnapshot(repoRoot, {
    policySnapshotPath: "/fake/path.json",
    policyHash: "fakehash",
    approvedBy: "Justin Hughes",
    reason: "test",
  });

  assert.equal(entry.created_by, "Justin Hughes", "must be readable, not a hash of the identity");
});

test("recordKnownGoodSnapshot auto-anchors the ledger when none exists yet", async () => {
  const repoRoot = makeRepoRoot();
  const entry = await recordKnownGoodSnapshot(repoRoot, {
    policySnapshotPath: "/fake/path.json",
    policyHash: "fakehash",
    approvedBy: "x",
    reason: "test",
  });

  assert.equal(typeof entry.ledger_head_hash, "string");
  assert.ok(entry.ledger_head_hash.length > 0);
});

test("listKnownGoodSnapshotsWithPaths returns every entry and respects a limit", async () => {
  // Note: sorted by filename, which embeds a millisecond timestamp — two
  // entries recorded within the same millisecond (both calls here run
  // synchronously, back to back) sort by their random UUID suffix, not
  // true creation order. This test checks count and membership, not a
  // specific order, to stay accurate to what the function actually
  // guarantees — an earlier version of this test asserted a specific
  // "second" entry landed last, which was flaky under exactly this
  // same-millisecond condition.
  const repoRoot = makeRepoRoot();
  await recordKnownGoodSnapshot(repoRoot, { policySnapshotPath: "/a", policyHash: "h1", approvedBy: "x", reason: "first" });
  await recordKnownGoodSnapshot(repoRoot, { policySnapshotPath: "/b", policyHash: "h2", approvedBy: "x", reason: "second" });

  const all = await listKnownGoodSnapshotsWithPaths(repoRoot);
  assert.equal(all.length, 2);
  assert.deepEqual(new Set(all.map((x) => x.entry.reason)), new Set(["first", "second"]));

  const limited = await listKnownGoodSnapshotsWithPaths(repoRoot, { limit: 1 });
  assert.equal(limited.length, 1);
});

test("listKnownGoodSnapshotsWithPaths returns an empty array when nothing has been recorded", async () => {
  assert.deepEqual(await listKnownGoodSnapshotsWithPaths(makeRepoRoot()), []);
});

test("listKnownGoodSnapshotsWithPaths silently skips a corrupted entry file", async () => {
  const repoRoot = makeRepoRoot();
  await recordKnownGoodSnapshot(repoRoot, { policySnapshotPath: "/a", policyHash: "h1", approvedBy: "x", reason: "good" });

  const entriesDir = path.join(repoRoot, ".auernyx", "kintsugi", "known_good", "entries");
  fs.writeFileSync(path.join(entriesDir, "0_corrupted.kgs.json"), "{not valid json");

  const all = await listKnownGoodSnapshotsWithPaths(repoRoot);
  assert.equal(all.length, 1);
  assert.equal(all[0].entry.reason, "good");
});
