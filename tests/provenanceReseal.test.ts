import assert from "node:assert/strict";
import test from "node:test";
import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";
import {
  activateJudgment,
  ensureGenesisRecord,
  genesisPath,
  isJudgmentActive,
  priorSealEvidence,
  recordSealedCopyIfMissing,
  sealedCopyPath,
  sealRecordPath,
  verifyProvenance,
} from "../core/provenance";
import { provenanceReseal } from "../capabilities/provenanceReseal";
import { governanceSelfTest } from "../capabilities/governanceSelfTest";
import { createRouter } from "../core/router";
import { createPolicy } from "../core/policy";
import { readGovernanceLock, writeGovernanceLock } from "../core/governanceLock";
import { getKintsugiPolicy, readFailures } from "../core/kintsugi/memory";
import { mondayTier2Review } from "../capabilities/mondayTier2Review";
import { runLifecycle } from "../core/runLifecycle";
import { runSentinelScan } from "../core/feneris";

// 2026-11-27 (Justin's decisions): an authorized re-seal. On a sealed install,
// any change to config/auernyx.config.json or config/allowlist.json trips
// Obsidian's Judgment, and before this there was no recorded way to accept a
// change on purpose: only putting the file back byte for byte, or wiping the
// audit history, or hand-writing genesis.json. provenanceReseal previews
// what changed, then (typed APPLY, the approver named in the SEALED copy, the
// audit ledger and every self-test check) appends a chained seal record. It is
// the 4th recovery capability: it runs under Judgment, the governance lock and
// Kintsugi FAILED_CLOSED, and never clears the lock or FAILED_CLOSED. Seal
// damage (genesis deleted, edited, unreadable; a broken seal chain) is
// re-sealable too, checked against the last surviving sealed copy.

const APPROVER = "Test Approver";
const SECRET = "daemon-secret-value-do-not-leak";

function writeConfig(repoRoot: string, cfg: unknown) {
  fs.writeFileSync(path.join(repoRoot, "config", "auernyx.config.json"), JSON.stringify(cfg, null, 2));
}

function readConfig(repoRoot: string): any {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, "config", "auernyx.config.json"), "utf8"));
}

function editConfig(repoRoot: string, mutate: (cfg: any) => void) {
  const cfg = readConfig(repoRoot);
  mutate(cfg);
  writeConfig(repoRoot, cfg);
}

function makeRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mk2-reseal-test-"));
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "test-project" }));
  fs.mkdirSync(path.join(dir, "config"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "config", "allowlist.json"),
    JSON.stringify({ allowedCapabilities: ["provenanceReseal", "searchDocApply", "memoryCheck", "docker"] }, null, 2)
  );
  writeConfig(dir, { governance: { approverIdentity: APPROVER }, writeEnabled: true, daemon: { port: 43117, secret: SECRET } });
  return dir;
}

function sealedRepo(): string {
  const repoRoot = makeRepo();
  assert.equal(ensureGenesisRecord(repoRoot, { writeEnabled: true }).created, true);
  assert.equal(verifyProvenance(repoRoot).ok, true);
  return repoRoot;
}

type LedgerEvent = { event: string; data: any };

function ctx(repoRoot: string, approval?: unknown, events: LedgerEvent[] = []) {
  return {
    repoRoot,
    sessionId: "test-session",
    approval,
    ledger: { append: (_s: string, event: string, data: unknown) => events.push({ event, data }) },
  } as any;
}

// identity null = an approval that names no identity at all.
function approval(identity: string | null = APPROVER, extra: Record<string, unknown> = {}) {
  return {
    approvedBy: "human",
    at: new Date().toISOString(),
    reason: "re-seal test",
    ...(identity === null ? {} : { identity }),
    apply: true,
    confirm: "APPLY",
    ...extra,
  };
}

async function preview(repoRoot: string): Promise<any> {
  return provenanceReseal(ctx(repoRoot, approval()), {});
}

async function apply(
  repoRoot: string,
  opts: { identity?: string | null; governanceHash?: string; approval?: unknown; events?: LedgerEvent[] } = {}
): Promise<any> {
  const p = await preview(repoRoot);
  const governanceHash = opts.governanceHash ?? p.confirm?.governanceHash;
  const a = opts.approval ?? approval(opts.identity === undefined ? APPROVER : opts.identity);
  return provenanceReseal(ctx(repoRoot, a, opts.events), { apply: true, governanceHash });
}

function sealFiles(repoRoot: string): string[] {
  const dir = path.join(repoRoot, ".auernyx", "provenance", "seals");
  return fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
}

function readSeal(repoRoot: string, seq: number): any {
  return JSON.parse(fs.readFileSync(sealRecordPath(repoRoot, seq), "utf8"));
}

function readGenesis(repoRoot: string): any {
  return JSON.parse(fs.readFileSync(genesisPath(repoRoot), "utf8"));
}

function sha256File(p: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
}

function judge(repoRoot: string) {
  // The provenance block runLifecycle runs before every request.
  const prov = verifyProvenance(repoRoot);
  if (!prov.ok) activateJudgment(repoRoot, prov);
  return prov;
}

// ─── Preview ────────────────────────────────────────────────────────────────

test("preview after a config edit names the cause, the file and the changed key, and writes nothing", async () => {
  const repoRoot = sealedRepo();
  const genesisBefore = fs.readFileSync(genesisPath(repoRoot), "utf8");
  editConfig(repoRoot, (c) => (c.daemon.port = 43118));

  const p = await preview(repoRoot);
  assert.equal(p.ok, true);
  assert.equal(p.preview, true);
  assert.equal(p.mode, "config_change");
  assert.equal(p.failure.code, "governance_hash_mismatch");

  const cfgChange = p.changes.find((c: any) => c.file === "config/auernyx.config.json");
  assert.equal(cfgChange.status, "changed");
  assert.deepEqual(cfgChange.keys, [{ path: "daemon.port", change: "changed", from: 43117, to: 43118 }]);
  assert.equal(p.changes.find((c: any) => c.file === "config/allowlist.json").status, "unchanged");
  assert.match(p.confirm.governanceHash, /^[0-9a-f]{64}$/);

  assert.deepEqual(sealFiles(repoRoot), []);
  assert.equal(fs.readFileSync(genesisPath(repoRoot), "utf8"), genesisBefore);
  assert.equal(fs.existsSync(sealedCopyPath(repoRoot, 1)), false);
});

test("the daemon secret never appears in the sealed copy or in the preview", async () => {
  const repoRoot = sealedRepo();
  assert.ok(fs.existsSync(sealedCopyPath(repoRoot, 0)), "sealing writes sealed copy 0");
  assert.ok(!fs.readFileSync(sealedCopyPath(repoRoot, 0), "utf8").includes(SECRET));

  editConfig(repoRoot, (c) => (c.daemon.secret = SECRET + "-rotated"));
  const p = await preview(repoRoot);
  const text = JSON.stringify(p);
  assert.ok(!text.includes(SECRET), "neither the old nor the new secret value is shown");

  const keys = p.changes.find((c: any) => c.file === "config/auernyx.config.json").keys;
  assert.deepEqual(keys, [{ path: "daemon.secret", change: "changed", from: "[redacted]", to: "[redacted]" }]);
});

test("allowlist changes are listed as added and removed capabilities", async () => {
  const repoRoot = sealedRepo();
  fs.writeFileSync(
    path.join(repoRoot, "config", "allowlist.json"),
    JSON.stringify({ allowedCapabilities: ["provenanceReseal", "searchDocApply", "memoryCheck", "scanRepo"] }, null, 2)
  );
  const p = await preview(repoRoot);
  const change = p.changes.find((c: any) => c.file === "config/allowlist.json");
  assert.equal(change.status, "changed");
  assert.equal(change.keys.length, 1);
  assert.equal(change.keys[0].path, "allowedCapabilities");
  assert.deepEqual(change.keys[0].added, ["scanRepo"]);
  assert.deepEqual(change.keys[0].removed, ["docker"]);
});

// ─── Apply ──────────────────────────────────────────────────────────────────

test("APPLY by the sealed approver re-seals: chained record, genesis untouched, Judgment cleared, Kintsugi record", async () => {
  const repoRoot = sealedRepo();
  const genesisBefore = fs.readFileSync(genesisPath(repoRoot), "utf8");
  editConfig(repoRoot, (c) => (c.daemon.port = 43118));
  assert.equal(judge(repoRoot).ok, false);
  assert.equal(isJudgmentActive(repoRoot), true);

  const r = await apply(repoRoot);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.resealed.seq, 1);
  assert.equal(r.judgmentCleared, true);

  assert.equal(fs.readFileSync(genesisPath(repoRoot), "utf8"), genesisBefore, "genesis.json is never rewritten");
  const seal = readSeal(repoRoot, 1);
  assert.equal(seal.seq, 1);
  assert.equal(seal.previous_record_hash, readGenesis(repoRoot).record_hash);
  assert.equal(seal.governance_hash, r.resealed.governance_hash);
  assert.equal(seal.failure.code, "governance_hash_mismatch");
  assert.equal(seal.anchor, undefined);
  assert.equal(seal.hitl_approval.approved_by.actor_id, APPROVER);
  assert.equal(seal.hitl_approval.reason, "re-seal test");
  assert.equal(seal.restoration_proof.ref, ".auernyx/provenance/sealed/000001.json");
  assert.equal(seal.restoration_proof.sha256, sha256File(sealedCopyPath(repoRoot, 1)));

  assert.equal(verifyProvenance(repoRoot).ok, true);
  assert.equal(isJudgmentActive(repoRoot), false);

  const kintsugi = (await readFailures(repoRoot)) as any[];
  const record = kintsugi.find((k) => k.normalized_error_code === "PROVENANCE_RESEAL");
  assert.ok(record, "the re-seal is recorded in the Kintsugi ledger");
  assert.equal(record.approved_by, APPROVER);
  assert.equal(record.post_state, seal.governance_hash);
});

test("a second change re-seals again, chained to the first seal", async () => {
  const repoRoot = sealedRepo();
  editConfig(repoRoot, (c) => (c.daemon.port = 43118));
  assert.equal((await apply(repoRoot)).ok, true);
  editConfig(repoRoot, (c) => (c.daemon.port = 43119));
  const r = await apply(repoRoot);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.resealed.seq, 2);
  assert.equal(readSeal(repoRoot, 2).previous_record_hash, readSeal(repoRoot, 1).record_hash);
  assert.equal(verifyProvenance(repoRoot).ok, true);
});

test("apply refuses when the config changed after the preview", async () => {
  const repoRoot = sealedRepo();
  editConfig(repoRoot, (c) => (c.daemon.port = 43118));
  const p = await preview(repoRoot);
  editConfig(repoRoot, (c) => (c.daemon.port = 43120));

  const r = await apply(repoRoot, { governanceHash: p.confirm.governanceHash });
  assert.equal(r.ok, false);
  assert.equal(r.error, "PREVIEW_STALE");
  assert.deepEqual(sealFiles(repoRoot), []);
});

test("apply must name the reviewed state (governanceHash)", async () => {
  const repoRoot = sealedRepo();
  editConfig(repoRoot, (c) => (c.daemon.port = 43118));
  const r = (await provenanceReseal(ctx(repoRoot, approval()), { apply: true })) as any;
  assert.equal(r.ok, false);
  assert.equal(r.error, "CONFIRM_HASH_REQUIRED");
  assert.deepEqual(sealFiles(repoRoot), []);
});

test("apply without typed APPLY is refused and writes nothing", async () => {
  const repoRoot = sealedRepo();
  editConfig(repoRoot, (c) => (c.daemon.port = 43118));
  const r = await apply(repoRoot, { approval: approval(APPROVER, { confirm: undefined }) });
  assert.equal(r.ok, false);
  assert.equal(r.error, "HIL_REQUIRED");
  assert.deepEqual(sealFiles(repoRoot), []);
});

// ─── Approver identity ──────────────────────────────────────────────────────

test("someone who puts their own name in the config can't approve their own re-seal", async () => {
  const repoRoot = sealedRepo();
  editConfig(repoRoot, (c) => (c.governance.approverIdentity = "Mallory"));
  const events: LedgerEvent[] = [];
  const r = await apply(repoRoot, { identity: "Mallory", events });
  assert.equal(r.ok, false);
  assert.equal(r.error, "SEALED_APPROVER_MISMATCH");
  assert.deepEqual(sealFiles(repoRoot), []);
  assert.equal(verifyProvenance(repoRoot).ok, false);
  assert.ok(events.some((e) => e.event === "provenance.reseal.refused" && e.data.reason === "SEALED_APPROVER_MISMATCH"));
});

test("handover: the old approver signs off on a new approver; after that only the new one can re-seal", async () => {
  const repoRoot = sealedRepo();
  editConfig(repoRoot, (c) => (c.governance.approverIdentity = "New Approver"));
  const r1 = await apply(repoRoot, { identity: APPROVER });
  assert.equal(r1.ok, true, JSON.stringify(r1));
  assert.equal(readSeal(repoRoot, 1).approver_identity, "New Approver");

  editConfig(repoRoot, (c) => (c.daemon.port = 43121));
  assert.equal((await apply(repoRoot, { identity: APPROVER })).error, "SEALED_APPROVER_MISMATCH");
  const r2 = await apply(repoRoot, { identity: "New Approver" });
  assert.equal(r2.ok, true, JSON.stringify(r2));
  assert.equal(r2.resealed.seq, 2);
});

test("a missing identity is refused", async () => {
  const repoRoot = sealedRepo();
  editConfig(repoRoot, (c) => (c.daemon.port = 43118));
  const r = await apply(repoRoot, { identity: null });
  assert.equal(r.ok, false);
  assert.equal(r.error, "SEALED_APPROVER_MISMATCH");
  assert.deepEqual(sealFiles(repoRoot), []);
});

// ─── Preconditions (same bar as governanceUnlock) ───────────────────────────

test("a broken audit ledger blocks the re-seal", async () => {
  const repoRoot = sealedRepo();
  editConfig(repoRoot, (c) => (c.daemon.port = 43118));
  fs.mkdirSync(path.join(repoRoot, "logs"), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, "logs", "ledger.ndjson"), "not json\n");
  const r = await apply(repoRoot);
  assert.equal(r.ok, false);
  assert.equal(r.error, "AUDIT_INVARIANT_VIOLATION");
  assert.deepEqual(sealFiles(repoRoot), []);
});

test("a failing self-test check blocks the re-seal", async () => {
  const repoRoot = sealedRepo();
  await governanceSelfTest(ctx(repoRoot)); // creates real Kintsugi ledger records
  const recordsDir = path.join(repoRoot, ".auernyx", "kintsugi", "ledger", "records");
  const victimFile = fs.readdirSync(recordsDir).filter((f) => f.endsWith(".json"))[0];
  const victim = JSON.parse(fs.readFileSync(path.join(recordsDir, victimFile), "utf8"));
  victim.requested_action = "TAMPERED";
  fs.writeFileSync(path.join(recordsDir, victimFile), JSON.stringify(victim));

  editConfig(repoRoot, (c) => (c.daemon.port = 43118));
  const r = await apply(repoRoot);
  assert.equal(r.ok, false);
  assert.equal(r.error, "PRECONDITIONS_NOT_MET");
  assert.ok(r.failedChecks.includes("kintsugi_integrity"));
  assert.deepEqual(sealFiles(repoRoot), []);
});

// ─── Seals from before sealed copies ────────────────────────────────────────

test("a seal with no sealed copy can't be re-sealed until the config matches again; then the copy is written and it works", async () => {
  const repoRoot = sealedRepo();
  fs.rmSync(sealedCopyPath(repoRoot, 0)); // a genesis written before sealed copies existed
  editConfig(repoRoot, (c) => (c.daemon.port = 43118));

  const refused = await apply(repoRoot);
  assert.equal(refused.ok, false);
  assert.equal(refused.error, "SEALED_APPROVER_UNKNOWN");
  assert.match(refused.whatWouldBeRequired, /back/i);
  assert.deepEqual(sealFiles(repoRoot), []);

  editConfig(repoRoot, (c) => (c.daemon.port = 43117));
  assert.equal(verifyProvenance(repoRoot).ok, true);
  recordSealedCopyIfMissing(repoRoot, { writeEnabled: true });
  assert.ok(fs.existsSync(sealedCopyPath(repoRoot, 0)));

  editConfig(repoRoot, (c) => (c.daemon.port = 43118));
  const r = await apply(repoRoot);
  assert.equal(r.ok, true, JSON.stringify(r));
});

test("a missing sealed copy is only written back with writes on and provenance passing, byte-identical to the original", () => {
  const repoRoot = sealedRepo();
  const original = fs.readFileSync(sealedCopyPath(repoRoot, 0), "utf8");
  fs.rmSync(sealedCopyPath(repoRoot, 0));

  recordSealedCopyIfMissing(repoRoot, { writeEnabled: false });
  assert.equal(fs.existsSync(sealedCopyPath(repoRoot, 0)), false);

  editConfig(repoRoot, (c) => (c.daemon.port = 43118));
  recordSealedCopyIfMissing(repoRoot, { writeEnabled: true });
  assert.equal(fs.existsSync(sealedCopyPath(repoRoot, 0)), false, "never copies a config that doesn't match the seal");

  editConfig(repoRoot, (c) => (c.daemon.port = 43117));
  recordSealedCopyIfMissing(repoRoot, { writeEnabled: true });
  assert.equal(fs.readFileSync(sealedCopyPath(repoRoot, 0), "utf8"), original);
});

// ─── Nothing to do ──────────────────────────────────────────────────────────

test("an install that was never sealed gets NOT_SEALED, and nothing is written", async () => {
  const repoRoot = makeRepo();
  const r = await apply(repoRoot);
  assert.equal(r.ok, false);
  assert.equal(r.error, "NOT_SEALED");
  assert.equal(fs.existsSync(genesisPath(repoRoot)), false);
  assert.deepEqual(sealFiles(repoRoot), []);
});

test("with provenance intact there is nothing to re-seal and nothing is written", async () => {
  const repoRoot = sealedRepo();
  const p = await preview(repoRoot);
  assert.equal(p.ok, true);
  assert.equal(p.nothingToReseal, true);
  const r = (await provenanceReseal(ctx(repoRoot, approval()), { apply: true, governanceHash: "0".repeat(64) })) as any;
  assert.equal(r.nothingToReseal, true);
  assert.deepEqual(sealFiles(repoRoot), []);
});

// ─── Seal damage ────────────────────────────────────────────────────────────

test("genesis deleted: an approved re-seal anchors a new chain; genesis is not re-created; provenance verifies", async () => {
  const repoRoot = sealedRepo();
  fs.rmSync(genesisPath(repoRoot));
  assert.equal((verifyProvenance(repoRoot) as any).code, "genesis_deleted");

  const p = await preview(repoRoot);
  assert.equal(p.mode, "seal_damage");
  assert.equal(p.failure.code, "genesis_deleted");

  const r = await apply(repoRoot);
  assert.equal(r.ok, true, JSON.stringify(r));
  const seal = readSeal(repoRoot, 1);
  assert.deepEqual(seal.anchor, { genesis_sha256: null });
  assert.equal(seal.previous_record_hash, null);
  assert.equal(seal.failure.code, "genesis_deleted");

  assert.equal(verifyProvenance(repoRoot).ok, true);
  assert.equal(ensureGenesisRecord(repoRoot, { writeEnabled: true }).created, false);
  assert.equal(fs.existsSync(genesisPath(repoRoot)), false);
  assert.equal(verifyProvenance(repoRoot).ok, true);
});

test("Feneris stops flagging a missing genesis once an approved re-seal accepted its absence (and flags it before)", async () => {
  const repoRoot = sealedRepo();
  fs.rmSync(genesisPath(repoRoot));
  const genesisMissing = (r: any) => r.infractions.some((i: any) => i.rule_id === "FENERIS.PROVENANCE.GENESIS_MISSING");
  assert.equal(genesisMissing(runSentinelScan(repoRoot, "s", { writeEnabled: false })), true);
  assert.equal((await apply(repoRoot)).ok, true);
  assert.equal(genesisMissing(runSentinelScan(repoRoot, "s", { writeEnabled: false })), false);
});

test("genesis edited: the anchor pins the edited bytes; editing genesis again trips Judgment again", async () => {
  const repoRoot = sealedRepo();
  const g = readGenesis(repoRoot);
  fs.writeFileSync(genesisPath(repoRoot), JSON.stringify({ ...g, author_identity: "someone-else" }, null, 2));
  assert.equal((verifyProvenance(repoRoot) as any).code, "genesis_hash_mismatch");

  const r = await apply(repoRoot);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(readSeal(repoRoot, 1).anchor.genesis_sha256, sha256File(genesisPath(repoRoot)));
  assert.equal(verifyProvenance(repoRoot).ok, true);

  fs.writeFileSync(genesisPath(repoRoot), JSON.stringify({ ...g, author_identity: "a-third-person" }, null, 2));
  assert.equal((verifyProvenance(repoRoot) as any).code, "genesis_hash_mismatch");
});

test("genesis unreadable: re-sealable with approval", async () => {
  const repoRoot = sealedRepo();
  fs.writeFileSync(genesisPath(repoRoot), "{ not json");
  assert.equal((verifyProvenance(repoRoot) as any).code, "genesis_parse_error");
  const r = await apply(repoRoot);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(verifyProvenance(repoRoot).ok, true);
});

test("seal damage with no surviving sealed copy is refused", async () => {
  const repoRoot = sealedRepo();
  fs.rmSync(genesisPath(repoRoot));
  fs.rmSync(sealedCopyPath(repoRoot, 0));
  const r = await apply(repoRoot);
  assert.equal(r.ok, false);
  assert.equal(r.error, "NO_SEALED_COPY");
  assert.deepEqual(sealFiles(repoRoot), []);
});

test("a damage re-seal checks the approver against the surviving sealed copy, not the edited config", async () => {
  const repoRoot = sealedRepo();
  fs.rmSync(genesisPath(repoRoot));
  editConfig(repoRoot, (c) => (c.governance.approverIdentity = "Mallory"));
  assert.equal((await apply(repoRoot, { identity: "Mallory" })).error, "SEALED_APPROVER_MISMATCH");
  const r = await apply(repoRoot, { identity: APPROVER });
  assert.equal(r.ok, true, JSON.stringify(r));
});

// ─── Seal chain integrity ───────────────────────────────────────────────────

async function sealedTwice(): Promise<string> {
  const repoRoot = sealedRepo();
  editConfig(repoRoot, (c) => (c.daemon.port = 43118));
  assert.equal((await apply(repoRoot)).ok, true);
  editConfig(repoRoot, (c) => (c.daemon.port = 43119));
  assert.equal((await apply(repoRoot)).ok, true);
  assert.equal(verifyProvenance(repoRoot).ok, true);
  return repoRoot;
}

test("an edited seal record breaks the chain", async () => {
  const repoRoot = await sealedTwice();
  const seal = readSeal(repoRoot, 1);
  fs.writeFileSync(sealRecordPath(repoRoot, 1), JSON.stringify({ ...seal, approver_identity: "Mallory" }, null, 2));
  assert.equal((verifyProvenance(repoRoot) as any).code, "seal_chain_broken");
});

test("deleting the newest seal record is caught: its sealed copy is still there", async () => {
  const repoRoot = await sealedTwice();
  fs.rmSync(sealRecordPath(repoRoot, 2));
  assert.equal((verifyProvenance(repoRoot) as any).code, "seal_chain_broken");
});

test("deleting a seal record in the middle is caught as a gap", async () => {
  const repoRoot = await sealedTwice();
  fs.rmSync(sealRecordPath(repoRoot, 1));
  assert.equal((verifyProvenance(repoRoot) as any).code, "seal_chain_broken");
});

test("a broken chain is re-sealable with approval; verification restarts at the anchor", async () => {
  const repoRoot = await sealedTwice();
  const seal = readSeal(repoRoot, 1);
  fs.writeFileSync(sealRecordPath(repoRoot, 1), JSON.stringify({ ...seal, approver_identity: "Mallory" }, null, 2));
  assert.equal((verifyProvenance(repoRoot) as any).code, "seal_chain_broken");

  const r = await apply(repoRoot);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.resealed.seq, 3);
  assert.equal(readSeal(repoRoot, 3).anchor.genesis_sha256, sha256File(genesisPath(repoRoot)));
  assert.equal(verifyProvenance(repoRoot).ok, true);
});

test("sealed copies count as evidence the install was sealed, so deleting genesis and the audit log is still caught", () => {
  const repoRoot = sealedRepo();
  fs.rmSync(genesisPath(repoRoot));
  fs.rmSync(path.join(repoRoot, ".auernyx", "provenance", "audit.ndjson"));
  assert.ok(priorSealEvidence(repoRoot).includes("sealed_copies"));
  assert.equal((verifyProvenance(repoRoot) as any).code, "genesis_deleted");
  assert.equal(ensureGenesisRecord(repoRoot, { writeEnabled: true }).created, false);
});

// ─── Router gates ───────────────────────────────────────────────────────────

function routerCtx(repoRoot: string) {
  return { repoRoot, sessionId: "test-session", execution: { planId: "p1", stepId: "s1" } } as any;
}

function makeRouter(repoRoot: string) {
  return createRouter(createPolicy(repoRoot), {
    provenanceReseal,
    searchDocApply: async () => ({ ok: true, ran: "searchDocApply" }),
    memoryCheck: async () => ({ ok: true, ran: "memoryCheck" }),
    docker: async () => ({ ok: true, ran: "docker" }),
  } as any);
}

async function routerApply(repoRoot: string, identity = APPROVER): Promise<any> {
  const router = makeRouter(repoRoot);
  const p = (await router.run("provenanceReseal" as any, routerCtx(repoRoot), {}, approval(identity) as any)) as any;
  return router.run("provenanceReseal" as any, routerCtx(repoRoot), { apply: true, governanceHash: p.confirm.governanceHash }, approval(identity) as any);
}

test("under Judgment the router runs provenanceReseal but still refuses every other write", async () => {
  const repoRoot = sealedRepo();
  editConfig(repoRoot, (c) => (c.daemon.port = 43118));
  judge(repoRoot);
  const router = makeRouter(repoRoot);
  await assert.rejects(
    () => router.run("searchDocApply" as any, routerCtx(repoRoot), undefined, approval() as any),
    /obsidian_judgment_active/
  );
  const r = await routerApply(repoRoot);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(isJudgmentActive(repoRoot), false);
});

test("the router checks no config identity for provenanceReseal (the capability checks the sealed one), so a handover goes through", async () => {
  const repoRoot = sealedRepo();
  editConfig(repoRoot, (c) => (c.governance.approverIdentity = "New Approver"));
  judge(repoRoot);
  const r = await routerApply(repoRoot, APPROVER);
  assert.equal(r.ok, true, JSON.stringify(r));
});

test("provenanceReseal runs while the governance lock is on, and leaves the lock on", async () => {
  const repoRoot = sealedRepo();
  editConfig(repoRoot, (c) => (c.daemon.port = 43118));
  judge(repoRoot);
  writeGovernanceLock(repoRoot, { locked: true, reason: "test lock" });

  const r = await routerApply(repoRoot);
  assert.equal(r.ok, true, JSON.stringify(r));
  const lock = readGovernanceLock(repoRoot);
  assert.equal(lock.locked, true, "only governanceUnlock clears the lock");
  assert.equal(lock.reason, "test lock");
});

test("provenanceReseal runs in Kintsugi FAILED_CLOSED and leaves FAILED_CLOSED in place", async () => {
  const repoRoot = sealedRepo();
  const policyDir = path.join(repoRoot, ".auernyx", "kintsugi", "policy");
  fs.mkdirSync(policyDir, { recursive: true });
  fs.writeFileSync(path.join(policyDir, "active.policy.json"), JSON.stringify({ ...getKintsugiPolicy(repoRoot), riskTolerance: "FAILED_CLOSED" }));
  editConfig(repoRoot, (c) => (c.daemon.port = 43118));
  judge(repoRoot);

  const r = await routerApply(repoRoot);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(getKintsugiPolicy(repoRoot).riskTolerance, "FAILED_CLOSED", "only governanceUnlock lifts FAILED_CLOSED");
});

test("the Tier 2 CONTROLLED gate still holds for other Tier 2 capabilities", async () => {
  const repoRoot = sealedRepo();
  await assert.rejects(
    () => makeRouter(repoRoot).run("docker" as any, routerCtx(repoRoot), undefined, approval() as any),
    /risk_tolerance_insufficient/
  );
});

test("intent text routes to provenanceReseal", () => {
  const router = makeRouter(makeRepo());
  assert.equal(router.route({ raw: "reseal provenance" }), "provenanceReseal");
  assert.equal(router.route({ raw: "re-seal the governance config" }), "provenanceReseal");
});

test("Monday's Tier 2 review describes provenanceReseal", async () => {
  const result = (await mondayTier2Review(ctx(makeRepo()), {})) as any;
  assert.ok(result.tier2_capabilities.includes("provenanceReseal"));
});

// ─── Through the real lifecycle ─────────────────────────────────────────────

function gitRepo(): string {
  const repoRoot = makeRepo();
  fs.writeFileSync(path.join(repoRoot, ".gitignore"), ".canon/\nvar/canon/\n.auernyx/\nlogs/\n");
  execFileSync("git", ["init", "-q"], { cwd: repoRoot });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoRoot });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: repoRoot });
  execFileSync("git", ["add", "-A"], { cwd: repoRoot });
  execFileSync("git", ["commit", "-q", "-m", "initial"], { cwd: repoRoot });
  return repoRoot;
}

test("a write-enabled run on a sealed install with no sealed copy writes the copy", async () => {
  const repoRoot = gitRepo();
  assert.equal(ensureGenesisRecord(repoRoot, { writeEnabled: true }).created, true);
  fs.rmSync(sealedCopyPath(repoRoot, 0));
  await runLifecycle({ router: makeRouter(repoRoot), ctx: { repoRoot, sessionId: "s" } as any, intent: "memory check" });
  assert.ok(fs.existsSync(sealedCopyPath(repoRoot, 0)));
});

test("end to end through runLifecycle: preview, then apply with the previewed hash, clears Judgment", async () => {
  const repoRoot = gitRepo();
  assert.equal(ensureGenesisRecord(repoRoot, { writeEnabled: true }).created, true);
  editConfig(repoRoot, (c) => (c.daemon.port = 43118)); // uncommitted: the tree is dirty

  const stepApproval = approval(APPROVER, { acknowledgedRollbackPointIds: ["rb-1"], allowDirty: true });
  const first = (await runLifecycle({
    router: makeRouter(repoRoot),
    ctx: { repoRoot, sessionId: "s" } as any,
    intent: "reseal provenance",
    input: {},
    approval: stepApproval as any,
  })) as any;
  assert.equal(first.ok, true, JSON.stringify(first.refusal ?? first));
  const previewOut = first.result[0].output;
  assert.equal(previewOut.preview, true);
  assert.equal(isJudgmentActive(repoRoot), true);

  const second = (await runLifecycle({
    router: makeRouter(repoRoot),
    ctx: { repoRoot, sessionId: "s" } as any,
    intent: "reseal provenance",
    input: { apply: true, governanceHash: previewOut.confirm.governanceHash },
    approval: stepApproval as any,
  })) as any;
  assert.equal(second.ok, true, JSON.stringify(second.refusal ?? second));
  assert.equal(second.result[0].output.ok, true, JSON.stringify(second.result[0].output));
  assert.equal(verifyProvenance(repoRoot).ok, true);
  assert.equal(isJudgmentActive(repoRoot), false);
});
