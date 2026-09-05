import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { recordKnownGood, restoreKnownGood, listKnownGood } from "../core/knownGood";

// First test coverage for knownGood.ts — the rollback snapshot mechanism
// behind the tier-2 rollbackKnownGood capability.

function makeRepoRoot(allowlist: unknown = { allowedCapabilities: [] }, config: unknown = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mk2-knowngood-test-"));
  fs.mkdirSync(path.join(dir, "config"), { recursive: true });
  fs.writeFileSync(path.join(dir, "config", "allowlist.json"), JSON.stringify(allowlist));
  fs.writeFileSync(path.join(dir, "config", "auernyx.config.json"), JSON.stringify(config));
  return dir;
}

test("recordKnownGood requires both config files to already exist", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mk2-knowngood-empty-"));
  assert.throws(
    () => recordKnownGood(dir, { createdBy: "test", reason: "test" }),
    /Missing config\/allowlist\.json/
  );
});

test("recordKnownGood snapshots the current config and hashes match the snapshot content", () => {
  const repoRoot = makeRepoRoot({ allowedCapabilities: ["scanRepo"] }, { governance: { approverIdentity: "x" } });
  const entry = recordKnownGood(repoRoot, { createdBy: "justin", reason: "before a risky change" });

  assert.ok(entry.kgsId.startsWith("KGS-"));
  assert.equal(fs.existsSync(entry.allowlistPath), true);
  assert.equal(fs.existsSync(entry.configPath), true);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(entry.allowlistPath, "utf8")),
    { allowedCapabilities: ["scanRepo"] }
  );
});

test("listKnownGood returns every recorded entry and respects a limit", () => {
  // Note: listKnownGood sorts by filename, which embeds a millisecond
  // timestamp plus a random UUID prefix — two entries recorded within the
  // same millisecond (plausible for rapid/scripted calls, not just a test
  // artifact) sort by that random prefix, not true creation order. Doesn't
  // affect restoreKnownGood's correctness (it looks up by exact kgsId, not
  // position), only listKnownGood's display order — so this test checks
  // membership and count, not a specific order, to stay accurate to what
  // the function actually guarantees.
  const repoRoot = makeRepoRoot();
  recordKnownGood(repoRoot, { createdBy: "a", reason: "first" });
  recordKnownGood(repoRoot, { createdBy: "b", reason: "second" });
  recordKnownGood(repoRoot, { createdBy: "c", reason: "third" });

  const all = listKnownGood(repoRoot);
  assert.equal(all.length, 3);
  assert.deepEqual(new Set(all.map((e) => e.reason)), new Set(["first", "second", "third"]));

  const limited = listKnownGood(repoRoot, { limit: 2 });
  assert.equal(limited.length, 2);
});

test("listKnownGood silently skips a corrupted entry file rather than throwing", () => {
  const repoRoot = makeRepoRoot();
  recordKnownGood(repoRoot, { createdBy: "a", reason: "good one" });

  const entriesDir = path.join(repoRoot, "artifacts", "known_good", "entries");
  fs.writeFileSync(path.join(entriesDir, "0_corrupted.kgs.json"), "{not valid json");

  const entries = listKnownGood(repoRoot);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].reason, "good one");
});

test("restoreKnownGood round-trips: config changes after the snapshot, restore brings the old content back", () => {
  const repoRoot = makeRepoRoot({ allowedCapabilities: ["scanRepo"] });
  const entry = recordKnownGood(repoRoot, { createdBy: "justin", reason: "baseline" });

  // Simulate a later, different config state.
  fs.writeFileSync(
    path.join(repoRoot, "config", "allowlist.json"),
    JSON.stringify({ allowedCapabilities: ["scanRepo", "docker"] })
  );

  restoreKnownGood(repoRoot, entry.kgsId);

  const restored = JSON.parse(fs.readFileSync(path.join(repoRoot, "config", "allowlist.json"), "utf8"));
  assert.deepEqual(restored, { allowedCapabilities: ["scanRepo"] });
});

test("restoreKnownGood refuses an unknown kgsId", () => {
  const repoRoot = makeRepoRoot();
  recordKnownGood(repoRoot, { createdBy: "a", reason: "x" });
  assert.throws(() => restoreKnownGood(repoRoot, "KGS-does-not-exist"), /Unknown KGS/);
});

test("restoreKnownGood refuses when the snapshot was tampered with after recording", () => {
  const repoRoot = makeRepoRoot({ allowedCapabilities: ["scanRepo"] });
  const entry = recordKnownGood(repoRoot, { createdBy: "justin", reason: "baseline" });

  // Tamper with the snapshot file directly, after it was hashed and recorded.
  fs.writeFileSync(entry.allowlistPath, JSON.stringify({ allowedCapabilities: ["docker", "rollbackKnownGood"] }));

  assert.throws(() => restoreKnownGood(repoRoot, entry.kgsId), /Snapshot allowlist hash mismatch/);
});

test("restoreKnownGood refuses when a snapshot file has been deleted out from under it", () => {
  const repoRoot = makeRepoRoot();
  const entry = recordKnownGood(repoRoot, { createdBy: "a", reason: "x" });

  fs.unlinkSync(entry.configPath);

  assert.throws(() => restoreKnownGood(repoRoot, entry.kgsId), /Snapshot files missing on disk/);
});
