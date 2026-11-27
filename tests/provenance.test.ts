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

// 2026-11-27, Justin: Obsidian's Judgment must fail closed if the genesis file
// is deleted without prior authorization. Before this, ensureGenesisRecord
// re-created a missing genesis on the next write-enabled run, sealing
// whatever the config said at that moment, and Judgment cleared itself:
// deleting genesis.json was a silent re-seal. A deleted genesis looked
// exactly like an uninitialized repo. Now: if this install was already
// sealed (evidence below), a missing genesis is tampering, not a fresh start.
function provenanceAuditKinds(repoRoot: string): string[] {
  const p = path.join(repoRoot, ".auernyx", "provenance", "audit.ndjson");
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l).kind);
}

function sealThenDeleteGenesis(repoRoot: string) {
  assert.equal(ensureGenesisRecord(repoRoot, { writeEnabled: true }).created, true);
  assert.equal(verifyProvenance(repoRoot).ok, true);
  fs.rmSync(genesisPath(repoRoot));
}

test("a genesis deleted after sealing is NOT re-created; provenance fails closed with genesis_deleted", () => {
  const repoRoot = makeRepoRoot();
  sealThenDeleteGenesis(repoRoot);

  const again = ensureGenesisRecord(repoRoot, { writeEnabled: true });

  assert.equal(again.created, false);
  assert.equal(fs.existsSync(genesisPath(repoRoot)), false);
  const result = verifyProvenance(repoRoot);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "genesis_deleted");
});

test("the refused re-creation is written to the provenance audit log with its evidence", () => {
  const repoRoot = makeRepoRoot();
  sealThenDeleteGenesis(repoRoot);
  ensureGenesisRecord(repoRoot, { writeEnabled: true });

  const p = path.join(repoRoot, ".auernyx", "provenance", "audit.ndjson");
  const refused = fs.readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
    .find((e) => e.kind === "genesis.recreate_refused");
  assert.ok(refused, "genesis.recreate_refused must be logged");
  assert.ok(refused.data.evidence.includes("provenance_audit:genesis.created"));
});

test("deleting the provenance audit log along with genesis is still caught when Kintsugi ledger records exist", () => {
  const repoRoot = makeRepoRoot();
  sealThenDeleteGenesis(repoRoot);
  fs.rmSync(path.join(repoRoot, ".auernyx", "provenance"), { recursive: true });
  const records = path.join(repoRoot, ".auernyx", "kintsugi", "ledger", "records");
  fs.mkdirSync(records, { recursive: true });
  fs.writeFileSync(path.join(records, "r1.json"), "{}");

  assert.equal(ensureGenesisRecord(repoRoot, { writeEnabled: true }).created, false);
  const result = verifyProvenance(repoRoot);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "genesis_deleted");
});

test("...and when the main audit ledger has entries", () => {
  const repoRoot = makeRepoRoot();
  sealThenDeleteGenesis(repoRoot);
  fs.rmSync(path.join(repoRoot, ".auernyx", "provenance"), { recursive: true });
  fs.mkdirSync(path.join(repoRoot, "logs"), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, "logs", "ledger.ndjson"), '{"hash":"x"}\n');

  assert.equal(ensureGenesisRecord(repoRoot, { writeEnabled: true }).created, false);
  const result = verifyProvenance(repoRoot);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "genesis_deleted");
});

test("a fresh install that only ran read-only (audit log, active Judgment, no genesis.created) still seals on its first write-enabled run", () => {
  // The real state of a checkout that has only ever run with writes off.
  const repoRoot = makeRepoRoot();
  const missing = verifyProvenance(repoRoot);
  assert.equal(missing.ok, false);
  if (!missing.ok) {
    assert.equal(missing.code, "genesis_missing", "never sealed: still reported as uninitialized, not deleted");
    activateJudgment(repoRoot, missing);
  }
  assert.ok(provenanceAuditKinds(repoRoot).includes("judgment.activated"));

  assert.equal(ensureGenesisRecord(repoRoot, { writeEnabled: true }).created, true);
  assert.equal(verifyProvenance(repoRoot).ok, true);
});

test("end to end: after an unauthorized genesis deletion, Judgment activates and the router refuses writes", async () => {
  const { createRouter } = await import("../core/router");
  const { createPolicy } = await import("../core/policy");
  const repoRoot = makeRepoRoot();
  fs.mkdirSync(path.join(repoRoot, "config"), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, "config", "allowlist.json"), JSON.stringify({ allowedCapabilities: ["searchDocApply"] }));
  fs.writeFileSync(
    path.join(repoRoot, "config", "auernyx.config.json"),
    JSON.stringify({ governance: { approverIdentity: "Test Approver" }, writeEnabled: true })
  );
  sealThenDeleteGenesis(repoRoot);

  // The same provenance block runLifecycle runs before every request.
  ensureGenesisRecord(repoRoot, { writeEnabled: true });
  const prov = verifyProvenance(repoRoot);
  if (!prov.ok) activateJudgment(repoRoot, prov);
  else clearJudgment(repoRoot);

  assert.equal(isJudgmentActive(repoRoot), true);
  const router = createRouter(createPolicy(repoRoot), { searchDocApply: async () => ({ ok: true }) } as any);
  await assert.rejects(
    () => router.run("searchDocApply" as any, { repoRoot, sessionId: "s", execution: { planId: "p", stepId: "s1" } } as any, undefined,
      { approvedBy: "human", at: new Date().toISOString(), reason: "test", identity: "Test Approver" } as any),
    /obsidian_judgment_active/
  );
});
