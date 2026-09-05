import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { runSentinelScan, appendInfraction, readOpenInfractions, hasCriticalOpenInfractions } from "../core/feneris";
import { ensureGenesisRecord } from "../core/provenance";
import { writeGovernanceLock } from "../core/governanceLock";

// First test coverage for feneris.ts — the sentinel scan's individual
// checkXxx functions aren't exported, so they're exercised indirectly
// through runSentinelScan's aggregate result, matching how every real
// caller (governanceSelfTest and others) actually uses this module.
//
// Found and fixed a real detection gap while writing these: a MISSING
// config/allowlist.json raised zero allowlist-related infractions — only
// an existing-but-empty allowlist was caught. Verified directly: a fresh
// repo with no allowlist.json at all produced only the unrelated fresh-
// system infractions (receipt store missing, genesis missing), nothing
// about the allowlist itself, despite "nothing can execute" being exactly
// what this check exists to catch and a missing/corrupted file being at
// least as suspicious as an empty one.

function makeInitializedRepoRoot(): string {
  // "Initialized" here means: has a genesis record and a real allowlist —
  // the baseline state where only the specific condition under test should
  // raise an infraction, not every fresh-system signal at once.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mk2-feneris-test-"));
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "test-project" }));
  ensureGenesisRecord(dir, { writeEnabled: true });
  fs.mkdirSync(path.join(dir, "config"), { recursive: true });
  fs.writeFileSync(path.join(dir, "config", "allowlist.json"), JSON.stringify({ allowedCapabilities: ["scanRepo"] }));
  // An existing (even if empty) receipts dir avoids the always-fires
  // FENERIS.RECEIPT.STORE_MISSING info infraction that a truly fresh repo
  // would raise — "initialized" here means "has run before," not "never
  // touched," so this baseline isolates whichever specific condition a test
  // actually cares about.
  fs.mkdirSync(path.join(dir, ".auernyx", "receipts"), { recursive: true });
  return dir;
}

function ruleIds(repoRoot: string): string[] {
  return runSentinelScan(repoRoot, "test-session").infractions.map((i) => i.rule_id);
}

test("a fully initialized, healthy repo raises no infractions", () => {
  const report = runSentinelScan(makeInitializedRepoRoot(), "s1");
  assert.equal(report.infractions_raised, 0);
  assert.ok(report.summary.includes("No infractions"));
});

test("a missing allowlist.json is now caught (the fix)", () => {
  const repoRoot = makeInitializedRepoRoot();
  fs.unlinkSync(path.join(repoRoot, "config", "allowlist.json"));
  assert.ok(ruleIds(repoRoot).includes("FENERIS.ALLOWLIST.EMPTY"));
});

test("an unparseable allowlist.json is also caught", () => {
  const repoRoot = makeInitializedRepoRoot();
  fs.writeFileSync(path.join(repoRoot, "config", "allowlist.json"), "{not valid json");
  assert.ok(ruleIds(repoRoot).includes("FENERIS.ALLOWLIST.EMPTY"));
});

test("an allowlist.json with a non-array allowedCapabilities is also caught", () => {
  const repoRoot = makeInitializedRepoRoot();
  fs.writeFileSync(path.join(repoRoot, "config", "allowlist.json"), JSON.stringify({ allowedCapabilities: "not-an-array" }));
  assert.ok(ruleIds(repoRoot).includes("FENERIS.ALLOWLIST.EMPTY"));
});

test("an allowlist.json with real entries raises nothing", () => {
  const repoRoot = makeInitializedRepoRoot(); // already has one real entry
  assert.ok(!ruleIds(repoRoot).includes("FENERIS.ALLOWLIST.EMPTY"));
});

test("a missing genesis record is caught as critical", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mk2-feneris-test-"));
  fs.writeFileSync(path.join(repoRoot, "package.json"), JSON.stringify({ name: "x" }));
  fs.mkdirSync(path.join(repoRoot, "config"), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, "config", "allowlist.json"), JSON.stringify({ allowedCapabilities: ["scanRepo"] }));
  // Deliberately no ensureGenesisRecord call.

  const report = runSentinelScan(repoRoot, "s1");
  const genesis = report.infractions.find((i) => i.rule_id === "FENERIS.PROVENANCE.GENESIS_MISSING");
  assert.ok(genesis);
  assert.equal(genesis!.severity, "critical");
});

test("a governance lock with a legible reason raises a lower-severity warning than one without", () => {
  const repoRootWithReason = makeInitializedRepoRoot();
  writeGovernanceLock(repoRootWithReason, { locked: true, reason: "scheduled maintenance" });
  const withReason = runSentinelScan(repoRootWithReason, "s1").infractions.find((i) =>
    i.rule_id.startsWith("FENERIS.LOCK")
  );
  assert.equal(withReason?.rule_id, "FENERIS.LOCK.ACTIVE_KNOWN_REASON");
  assert.equal(withReason?.severity, "warn");

  const repoRootNoReason = makeInitializedRepoRoot();
  writeGovernanceLock(repoRootNoReason, { locked: true, reason: "" });
  const noReason = runSentinelScan(repoRootNoReason, "s1").infractions.find((i) => i.rule_id.startsWith("FENERIS.LOCK"));
  assert.equal(noReason?.rule_id, "FENERIS.LOCK.ACTIVE_UNKNOWN_REASON");
  assert.equal(noReason?.severity, "error");
});

test("an unlocked governance lock raises nothing", () => {
  const repoRoot = makeInitializedRepoRoot();
  assert.ok(!ruleIds(repoRoot).some((r) => r.startsWith("FENERIS.LOCK")));
});

test("a fresh repo with no receipts dir at all raises a low-severity info infraction", () => {
  const repoRoot = makeInitializedRepoRoot();
  fs.rmSync(path.join(repoRoot, ".auernyx", "receipts"), { recursive: true, force: true });
  const receiptInfraction = runSentinelScan(repoRoot, "s1").infractions.find(
    (i) => i.rule_id === "FENERIS.RECEIPT.STORE_MISSING"
  );
  assert.ok(receiptInfraction);
  assert.equal(receiptInfraction!.severity, "info");
});

let _receiptRunCounter = 0;
function makeReceiptRun(repoRoot: string, ageMs: number, complete: boolean): void {
  // A counter suffix keeps each call's directory name unique even when
  // several calls land in the same millisecond (routine when called this
  // fast, synchronously, in a test) — a shared "-fake" suffix collided
  // directory names together, silently merging what were meant to be
  // several distinct runs into one.
  const runId = `${Date.now() - ageMs}-fake${_receiptRunCounter++}`;
  const dir = path.join(repoRoot, ".auernyx", "receipts", runId);
  fs.mkdirSync(dir, { recursive: true });
  if (complete) fs.writeFileSync(path.join(dir, "final.json"), "{}");
}

test("incomplete receipt runs (older than the in-progress exclusion window) are flagged", () => {
  const repoRoot = makeInitializedRepoRoot();
  makeReceiptRun(repoRoot, 10_000, true);
  makeReceiptRun(repoRoot, 10_000, false);
  makeReceiptRun(repoRoot, 10_000, false);
  makeReceiptRun(repoRoot, 10_000, false);

  const infraction = runSentinelScan(repoRoot, "s1").infractions.find((i) => i.rule_id === "FENERIS.RECEIPT.INCOMPLETE");
  assert.ok(infraction);
  assert.equal(infraction!.severity, "error"); // 3+ incomplete
});

test("a currently in-progress run (within the exclusion window) is not counted as incomplete", () => {
  const repoRoot = makeInitializedRepoRoot();
  makeReceiptRun(repoRoot, 500, false); // too recent — excluded, mirrors the running-right-now scan itself
  assert.ok(!ruleIds(repoRoot).includes("FENERIS.RECEIPT.INCOMPLETE"));
});

test("appendInfraction persists a record and readOpenInfractions returns only open ones", () => {
  const repoRoot = makeInitializedRepoRoot();
  const report = runSentinelScan(repoRoot, "s1"); // healthy repo, appends nothing
  assert.equal(readOpenInfractions(repoRoot).length, 0);

  appendInfraction(repoRoot, {
    schema: "aesir.governance.infraction.v1",
    infraction_id: "manual-1",
    scope: "trunk",
    rule_id: "TEST.MANUAL",
    severity: "critical",
    status: "open",
    detected_by: { actor_id: "feneris", method: "sentinel_scan" },
    timestamps: { detected_at: new Date().toISOString() },
    evidence: [],
    feneris_assessment: { score: { scope: 1, severity: 1, sensitivity: 1, blast_radius: 1 }, origin_point: "x", rationale: "x" },
  });
  appendInfraction(repoRoot, {
    schema: "aesir.governance.infraction.v1",
    infraction_id: "manual-2",
    scope: "trunk",
    rule_id: "TEST.MANUAL_CLOSED",
    severity: "warn",
    status: "closed",
    detected_by: { actor_id: "feneris", method: "sentinel_scan" },
    timestamps: { detected_at: new Date().toISOString() },
    evidence: [],
    feneris_assessment: { score: { scope: 1, severity: 1, sensitivity: 1, blast_radius: 1 }, origin_point: "x", rationale: "x" },
  });

  const open = readOpenInfractions(repoRoot);
  assert.equal(open.length, 1);
  assert.equal(open[0].infraction_id, "manual-1");
  assert.equal(hasCriticalOpenInfractions(repoRoot), true);
  void report;
});

test("hasCriticalOpenInfractions is false when only non-critical/error infractions are open", () => {
  const repoRoot = makeInitializedRepoRoot();
  appendInfraction(repoRoot, {
    schema: "aesir.governance.infraction.v1",
    infraction_id: "manual-warn",
    scope: "trunk",
    rule_id: "TEST.WARN",
    severity: "warn",
    status: "open",
    detected_by: { actor_id: "feneris", method: "sentinel_scan" },
    timestamps: { detected_at: new Date().toISOString() },
    evidence: [],
    feneris_assessment: { score: { scope: 1, severity: 1, sensitivity: 1, blast_radius: 1 }, origin_point: "x", rationale: "x" },
  });
  assert.equal(hasCriticalOpenInfractions(repoRoot), false);
});

test(
  "known, documented characteristic (not fixed, a design question not a clear bug): a persisting condition is re-raised as a new infraction on every scan, not deduplicated",
  () => {
    const repoRoot = makeInitializedRepoRoot();
    writeGovernanceLock(repoRoot, { locked: true, reason: "ongoing maintenance" });

    runSentinelScan(repoRoot, "s1");
    runSentinelScan(repoRoot, "s2");
    runSentinelScan(repoRoot, "s3");

    const openLockInfractions = readOpenInfractions(repoRoot).filter((i) => i.rule_id.startsWith("FENERIS.LOCK"));
    // Three scans of the same still-active lock produced three separate open
    // infractions, not one. Pinning current behavior, not endorsing it — see
    // the memory note on this for the design question it raises for HIL review volume.
    assert.equal(openLockInfractions.length, 3);
  }
);
