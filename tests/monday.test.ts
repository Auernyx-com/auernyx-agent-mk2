import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { appendInfraction, readOpenInfractions, type FenerisInfraction } from "../core/feneris";
import {
  loadMondayPersona,
  loadMondayConfig,
  createMondayProvider,
  TemplateMondayProvider,
  formatInfractionForHuman,
  recordHilDisposition,
  readDispositions,
  getTrulyOpenInfractions,
  formatGovernanceLockForHuman,
  formatJudgmentForHuman,
} from "../core/monday";

// First test coverage for monday.ts. Found and fixed a real cache bug along
// the way: loadMondayPersona's cache was a single scalar, not keyed by
// repoRoot — a second call with a different repoRoot silently returned the
// first repoRoot's persona. Verified empirically before fixing (two distinct
// repos, two distinct persona files, the second load returned the first
// repo's persona).

function makeRepoRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mk2-monday-test-"));
}

function writePersona(repoRoot: string, member: string): void {
  fs.mkdirSync(path.join(repoRoot, "personas"), { recursive: true });
  fs.writeFileSync(
    path.join(repoRoot, "personas", "monday.json"),
    JSON.stringify({
      id: "monday",
      member,
      role: "Bridge",
      council_title: "Dancer in Chaos",
      vow: { short: "x", architects_mark: "y" },
      personality: { surface: "direct", core: "honesty" },
    })
  );
}

test("loadMondayPersona falls back to a sane default when no persona file exists", () => {
  const persona = loadMondayPersona(makeRepoRoot());
  assert.equal(persona.member, "Monday");
});

test("loadMondayPersona reads a real persona file correctly", () => {
  const repoRoot = makeRepoRoot();
  writePersona(repoRoot, "Custom Monday");
  assert.equal(loadMondayPersona(repoRoot).member, "Custom Monday");
});

test("loadMondayPersona does not cross-contaminate between two different repos (the cache bug)", () => {
  const repoA = makeRepoRoot();
  writePersona(repoA, "REPO-A-MONDAY");
  const repoB = makeRepoRoot();
  writePersona(repoB, "REPO-B-MONDAY");

  assert.equal(loadMondayPersona(repoA).member, "REPO-A-MONDAY");
  assert.equal(loadMondayPersona(repoB).member, "REPO-B-MONDAY");
  // And re-checking repoA again still returns its own persona, not repoB's.
  assert.equal(loadMondayPersona(repoA).member, "REPO-A-MONDAY");
});

test("loadMondayConfig returns empty-string defaults when unconfigured", () => {
  const cfg = loadMondayConfig(makeRepoRoot());
  assert.deepEqual(cfg, { llm: { provider: "", model: "" } });
});

test("loadMondayConfig reads a real monday.llm config through correctly", () => {
  const repoRoot = makeRepoRoot();
  fs.mkdirSync(path.join(repoRoot, "config"), { recursive: true });
  fs.writeFileSync(
    path.join(repoRoot, "config", "auernyx.config.json"),
    JSON.stringify({ monday: { llm: { provider: "claude", model: "claude-sonnet-5" } } })
  );
  assert.deepEqual(loadMondayConfig(repoRoot), { llm: { provider: "claude", model: "claude-sonnet-5" } });
});

test("createMondayProvider currently always returns the template provider regardless of config", () => {
  const provider = createMondayProvider({ llm: { provider: "claude", model: "x" } });
  assert.ok(provider instanceof TemplateMondayProvider);
});

test("TemplateMondayProvider echoes the user message back unchanged", async () => {
  const provider = new TemplateMondayProvider();
  assert.equal(await provider.complete("system prompt", "hello"), "hello");
});

function makeInfraction(overrides?: Partial<FenerisInfraction>): FenerisInfraction {
  return {
    schema: "aesir.governance.infraction.v1",
    infraction_id: "inf-1",
    scope: "network",
    rule_id: "rule-1",
    severity: "critical",
    status: "open",
    detected_by: { actor_id: "feneris", method: "sentinel_scan" },
    timestamps: { detected_at: "2026-01-01T00:00:00.000Z" },
    evidence: [{ ref: "pcap://x", sha256: "abc" }],
    feneris_assessment: {
      score: { scope: 5, severity: 8, sensitivity: 3, blast_radius: 4 } as any,
      origin_point: "check:x|component:y",
      rationale: "Something happened.",
    },
    ...overrides,
  };
}

test("formatInfractionForHuman includes the key fields a reviewer needs", () => {
  const text = formatInfractionForHuman(makeInfraction(), makeRepoRoot());
  assert.ok(text.includes("inf-1"));
  assert.ok(text.includes("CRITICAL"));
  assert.ok(text.includes("Something happened."));
  assert.ok(text.includes("Disposition required"));
});

test("formatInfractionForHuman includes notes only when present", () => {
  const withNotes = formatInfractionForHuman(makeInfraction({ notes: "extra context" }), makeRepoRoot());
  assert.ok(withNotes.includes("extra context"));

  const withoutNotes = formatInfractionForHuman(makeInfraction(), makeRepoRoot());
  assert.ok(!withoutNotes.includes("Notes:"));
});

test("recordHilDisposition persists a record with a content hash, and readDispositions reads it back", () => {
  const repoRoot = makeRepoRoot();
  const record = recordHilDisposition(repoRoot, {
    infraction_id: "inf-1",
    decision: "confirmed",
    rationale: "Reviewed and confirmed.",
    assessed_by: "Justin Hughes",
  });

  assert.equal(record.infraction_id, "inf-1");
  assert.equal(record.sha256.length, 64);

  const all = readDispositions(repoRoot);
  assert.equal(all.length, 1);
  assert.deepEqual(all[0], record);
});

test("readDispositions returns an empty array when nothing has been recorded yet", () => {
  assert.deepEqual(readDispositions(makeRepoRoot()), []);
});

test("multiple dispositions accumulate in order", () => {
  const repoRoot = makeRepoRoot();
  recordHilDisposition(repoRoot, { infraction_id: "a", decision: "closed", rationale: "x", assessed_by: "x" });
  recordHilDisposition(repoRoot, { infraction_id: "b", decision: "waived", rationale: "y", assessed_by: "y" });
  const all = readDispositions(repoRoot);
  assert.equal(all.length, 2);
  assert.equal(all[0].infraction_id, "a");
  assert.equal(all[1].infraction_id, "b");
});

// getTrulyOpenInfractions — real gap found while adding coverage for
// mondaySystemStatus/mondayInfractionReview: nothing anywhere ever marks a
// Feneris infraction as no-longer-open once a human dispositions it, so
// readOpenInfractions() keeps returning it forever. Verified directly:
// disposition a real infraction, then readOpenInfractions still returns it.
// getTrulyOpenInfractions reconciles Feneris's open infractions against
// Monday's own disposition records at read time.

test("getTrulyOpenInfractions excludes an infraction once it has been dispositioned (the fix)", () => {
  const repoRoot = makeRepoRoot();
  appendInfraction(repoRoot, makeInfraction({ infraction_id: "inf-open-then-closed" }));

  // Confirms the underlying gap is real: Feneris's own store never clears.
  assert.deepEqual(readOpenInfractions(repoRoot).map((i) => i.infraction_id), ["inf-open-then-closed"]);

  recordHilDisposition(repoRoot, {
    infraction_id: "inf-open-then-closed",
    decision: "confirmed",
    rationale: "reviewed",
    assessed_by: "tester",
  });

  assert.deepEqual(readOpenInfractions(repoRoot).map((i) => i.infraction_id), ["inf-open-then-closed"]);
  assert.deepEqual(getTrulyOpenInfractions(repoRoot), []);
});

test("getTrulyOpenInfractions leaves undispositioned infractions untouched", () => {
  const repoRoot = makeRepoRoot();
  appendInfraction(repoRoot, makeInfraction({ infraction_id: "inf-1" }));
  appendInfraction(repoRoot, makeInfraction({ infraction_id: "inf-2" }));

  recordHilDisposition(repoRoot, {
    infraction_id: "inf-1",
    decision: "false_positive",
    rationale: "not real",
    assessed_by: "tester",
  });

  assert.deepEqual(getTrulyOpenInfractions(repoRoot).map((i) => i.infraction_id), ["inf-2"]);
});

test("getTrulyOpenInfractions returns an empty array for a repo with no infractions at all", () => {
  assert.deepEqual(getTrulyOpenInfractions(makeRepoRoot()), []);
});

test("formatGovernanceLockForHuman reports normal operation when not locked", () => {
  const text = formatGovernanceLockForHuman({ locked: false }, makeRepoRoot());
  assert.ok(text.includes("operating normally"));
});

test("formatGovernanceLockForHuman reports the lock reason and self-test result when locked", () => {
  const text = formatGovernanceLockForHuman(
    {
      locked: true,
      reason: "integrity failure",
      lastSelfTest: { timestamp: "2026-01-01T00:00:00.000Z", ok: false, warnings: ["ledger mismatch"] },
    },
    makeRepoRoot()
  );
  assert.ok(text.includes("integrity failure"));
  assert.ok(text.includes("FAIL"));
  assert.ok(text.includes("ledger mismatch"));
  assert.ok(text.includes("governanceUnlock"));
});

test("formatJudgmentForHuman reports the failure code, reason, and that governanceUnlock will not help", () => {
  const text = formatJudgmentForHuman(
    {
      active: true,
      activated_at: "2026-01-01T00:00:00.000Z",
      failure: { code: "genesis_hash_mismatch", reason: "tampered" },
    },
    makeRepoRoot()
  );
  assert.ok(text.includes("genesis_hash_mismatch"));
  assert.ok(text.includes("tampered"));
  assert.ok(text.includes("will not clear it"));
});
