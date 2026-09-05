import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  ensureGenesisRecord,
  verifyProvenance,
  genesisPath,
  activateJudgment,
  clearJudgment,
  isJudgmentActive,
  readJudgment,
} from "../core/provenance";

// First test coverage for provenance.ts — the genesis hash + Obsidian's
// Judgment mechanism is the core fail-closed integrity check ("verifies
// genesis.json hash on every run; failure activates Obsidian's Judgment" per
// AUERNYX_AGENT_MK2_SUMMARY.md), and it had zero direct tests before this.

function makeRepoRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mk2-provenance-test-"));
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "test-project" }));
  return dir;
}

test("verifyProvenance fails closed when no genesis record exists yet", () => {
  const repoRoot = makeRepoRoot();
  const result = verifyProvenance(repoRoot);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "genesis_missing");
});

test("ensureGenesisRecord does nothing unless writes are enabled", () => {
  const repoRoot = makeRepoRoot();
  const result = ensureGenesisRecord(repoRoot, { writeEnabled: false });
  assert.equal(result.created, false);
  assert.equal(fs.existsSync(genesisPath(repoRoot)), false);
});

test("a genuine genesis record verifies clean, and stays clean across repeated checks", () => {
  const repoRoot = makeRepoRoot();
  const created = ensureGenesisRecord(repoRoot, { writeEnabled: true });
  assert.equal(created.created, true);

  assert.equal(verifyProvenance(repoRoot).ok, true);
  assert.equal(verifyProvenance(repoRoot).ok, true, "verification must be stable, not one-shot");
});

test("ensureGenesisRecord never overwrites an existing genesis record", () => {
  const repoRoot = makeRepoRoot();
  ensureGenesisRecord(repoRoot, { writeEnabled: true });
  const originalRaw = fs.readFileSync(genesisPath(repoRoot), "utf8");

  const second = ensureGenesisRecord(repoRoot, { writeEnabled: true });
  assert.equal(second.created, false);
  assert.equal(fs.readFileSync(genesisPath(repoRoot), "utf8"), originalRaw);
});

test("a tampered genesis field (hash left stale) is caught as a hash mismatch", () => {
  const repoRoot = makeRepoRoot();
  ensureGenesisRecord(repoRoot, { writeEnabled: true });

  const record = JSON.parse(fs.readFileSync(genesisPath(repoRoot), "utf8"));
  record.author_identity = "someone-else"; // tampered, record_hash left stale
  fs.writeFileSync(genesisPath(repoRoot), JSON.stringify(record, null, 2));

  const result = verifyProvenance(repoRoot);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "genesis_hash_mismatch");
});

test("a project_id that no longer matches package.json is caught", () => {
  const repoRoot = makeRepoRoot();
  ensureGenesisRecord(repoRoot, { writeEnabled: true });

  // Change what the project actually declares itself as, after genesis was sealed.
  fs.writeFileSync(path.join(repoRoot, "package.json"), JSON.stringify({ name: "renamed-project" }));

  const result = verifyProvenance(repoRoot);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "project_id_mismatch");
});

test("governance config drift after genesis is caught (expected behavior, not a bug — see runbook)", () => {
  const repoRoot = makeRepoRoot();
  fs.mkdirSync(path.join(repoRoot, "config"), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, "config", "allowlist.json"), JSON.stringify({ allowedCapabilities: [] }));
  ensureGenesisRecord(repoRoot, { writeEnabled: true });
  assert.equal(verifyProvenance(repoRoot).ok, true);

  // Any change to allowlist.json/auernyx.config.json after genesis moves the
  // observed governance hash away from what genesis recorded — by design,
  // this is meant to require an explicit genesis reset, not silently pass.
  fs.writeFileSync(
    path.join(repoRoot, "config", "allowlist.json"),
    JSON.stringify({ allowedCapabilities: ["scanRepo"] })
  );

  const result = verifyProvenance(repoRoot);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "governance_hash_mismatch");
});

test("Obsidian's Judgment: activate, read, and clear round-trip correctly", () => {
  const repoRoot = makeRepoRoot();
  assert.equal(isJudgmentActive(repoRoot), false, "no judgment file yet means not active");

  activateJudgment(repoRoot, { ok: false, code: "genesis_missing", reason: "test activation" });
  assert.equal(isJudgmentActive(repoRoot), true);

  const record = readJudgment(repoRoot);
  assert.equal(record?.active, true);
  assert.equal(record?.failure.code, "genesis_missing");

  clearJudgment(repoRoot);
  assert.equal(isJudgmentActive(repoRoot), false);
  assert.equal(readJudgment(repoRoot), null);
});
