import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { mondaySystemStatus } from "../capabilities/mondaySystemStatus";
import { mondayInfractionReview } from "../capabilities/mondayInfractionReview";
import { appendInfraction, type FenerisInfraction } from "../core/feneris";
import { recordHilDisposition, readDispositions } from "../core/monday";
import { writeGovernanceLock } from "../core/governanceLock";
import { activateJudgment } from "../core/provenance";

// Both capabilities previously called readOpenInfractions directly, so an
// infraction a human had already dispositioned via mondayInfractionReview
// kept showing up forever — in mondaySystemStatus's status/alerts, and in
// mondayInfractionReview's own "awaiting_disposition" listing, asking a human
// to re-review something already reviewed. Fixed by routing both through
// core/monday.ts's getTrulyOpenInfractions (see tests/monday.test.ts for that
// function's own coverage). These tests cover the capabilities end-to-end.

function makeRepoRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mk2-monday-cap-test-"));
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "test" }));
  return dir;
}

function ctx(repoRoot: string, approval?: unknown) {
  return { repoRoot, sessionId: "test-session", approval } as any;
}

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
      score: { scope: 5, severity: 8, sensitivity: 3, blast_radius: 4 },
      origin_point: "check:x|component:y",
      rationale: "Something happened.",
    },
    ...overrides,
  };
}

// ─── mondaySystemStatus ────────────────────────────────────────────────────

test("mondaySystemStatus reports CLEAR with no alerts on a fresh repo", async () => {
  const result = (await mondaySystemStatus(ctx(makeRepoRoot()))) as any;
  assert.equal(result.status, "CLEAR");
  assert.deepEqual(result.alerts, []);
  assert.equal(result.open_infractions.count, 0);
  assert.match(result.message, /System is clear/);
});

test("mondaySystemStatus surfaces an open infraction as an alert", async () => {
  const repoRoot = makeRepoRoot();
  appendInfraction(repoRoot, makeInfraction({ infraction_id: "inf-open" }));

  const result = (await mondaySystemStatus(ctx(repoRoot))) as any;
  assert.equal(result.status, "ATTENTION_REQUIRED");
  assert.ok(result.alerts.includes("OPEN_INFRACTIONS(1)"));
  assert.deepEqual(result.open_infractions.ids, ["inf-open"]);
});

test("mondaySystemStatus (the fix) stops reporting an infraction once it has been dispositioned", async () => {
  const repoRoot = makeRepoRoot();
  appendInfraction(repoRoot, makeInfraction({ infraction_id: "inf-dispositioned" }));
  recordHilDisposition(repoRoot, {
    infraction_id: "inf-dispositioned",
    decision: "confirmed",
    rationale: "reviewed",
    assessed_by: "tester",
  });

  const result = (await mondaySystemStatus(ctx(repoRoot))) as any;
  assert.equal(result.status, "CLEAR");
  assert.equal(result.open_infractions.count, 0);
  assert.ok(!result.alerts.some((a: string) => a.startsWith("OPEN_INFRACTIONS")));
});

test("mondaySystemStatus surfaces an active governance lock as an alert", async () => {
  const repoRoot = makeRepoRoot();
  writeGovernanceLock(repoRoot, { locked: true, reason: "test lock" });

  const result = (await mondaySystemStatus(ctx(repoRoot))) as any;
  assert.equal(result.status, "ATTENTION_REQUIRED");
  assert.ok(result.alerts.includes("GOVERNANCE_LOCK"));
  assert.equal(result.governance_lock.active, true);
});

test("mondaySystemStatus surfaces an active Obsidian judgment as an alert", async () => {
  const repoRoot = makeRepoRoot();
  activateJudgment(repoRoot, { ok: false, code: "genesis_hash_mismatch", reason: "tampered" } as any);

  const result = (await mondaySystemStatus(ctx(repoRoot))) as any;
  assert.equal(result.status, "ATTENTION_REQUIRED");
  assert.ok(result.alerts.includes("OBSIDIAN_JUDGMENT"));
  assert.equal(result.obsidian_judgment.active, true);
});

// ─── mondayInfractionReview ────────────────────────────────────────────────

test("mondayInfractionReview reports no_open_infractions on a fresh repo", async () => {
  const result = (await mondayInfractionReview(ctx(makeRepoRoot()))) as any;
  assert.equal(result.status, "no_open_infractions");
  assert.equal(result.dispositions_written, 0);
});

test("mondayInfractionReview (the fix) does not re-surface an already-dispositioned infraction for review", async () => {
  const repoRoot = makeRepoRoot();
  appendInfraction(repoRoot, makeInfraction({ infraction_id: "inf-a" }));
  recordHilDisposition(repoRoot, {
    infraction_id: "inf-a",
    decision: "closed",
    rationale: "handled",
    assessed_by: "tester",
  });

  const result = (await mondayInfractionReview(ctx(repoRoot))) as any;
  assert.equal(result.status, "no_open_infractions");
});

test("mondayInfractionReview phase 1 surfaces open infractions awaiting disposition", async () => {
  const repoRoot = makeRepoRoot();
  appendInfraction(repoRoot, makeInfraction({ infraction_id: "inf-a" }));
  appendInfraction(repoRoot, makeInfraction({ infraction_id: "inf-b", rule_id: "rule-2" }));

  const result = (await mondayInfractionReview(ctx(repoRoot))) as any;
  assert.equal(result.status, "awaiting_disposition");
  assert.equal(result.open_count, 2);
  assert.deepEqual(
    result.infractions.map((i: any) => i.infraction_id).sort(),
    ["inf-a", "inf-b"]
  );
});

test("mondayInfractionReview phase 2 writes a valid disposition and reduces remaining_open", async () => {
  const repoRoot = makeRepoRoot();
  appendInfraction(repoRoot, makeInfraction({ infraction_id: "inf-a" }));
  appendInfraction(repoRoot, makeInfraction({ infraction_id: "inf-b", rule_id: "rule-2" }));

  const result = (await mondayInfractionReview(ctx(repoRoot), {
    dispositions: [{ infraction_id: "inf-a", decision: "confirmed", rationale: "yep" }],
  })) as any;

  assert.equal(result.status, "dispositions_written");
  assert.equal(result.dispositions_written, 1);
  assert.equal(result.remaining_open, 1);
  assert.equal(result.written[0].infraction_id, "inf-a");
  assert.equal(result.written[0].decision, "confirmed");
});

test("mondayInfractionReview rejects an invalid decision and an unknown infraction_id without writing", async () => {
  const repoRoot = makeRepoRoot();
  appendInfraction(repoRoot, makeInfraction({ infraction_id: "inf-a" }));

  const result = (await mondayInfractionReview(ctx(repoRoot), {
    dispositions: [
      { infraction_id: "inf-a", decision: "not-a-real-decision" as any, rationale: "x" },
      { infraction_id: "does-not-exist", decision: "confirmed", rationale: "x" },
    ],
  })) as any;

  assert.equal(result.dispositions_written, 0);
  assert.equal(result.dispositions_invalid.length, 2);
});

test("mondayInfractionReview skips (does not double-write) a disposition for an infraction already dispositioned in an earlier call", async () => {
  const repoRoot = makeRepoRoot();
  appendInfraction(repoRoot, makeInfraction({ infraction_id: "inf-a" }));
  recordHilDisposition(repoRoot, {
    infraction_id: "inf-a",
    decision: "confirmed",
    rationale: "first pass",
    assessed_by: "tester",
  });

  // inf-a is truly-closed now, so it won't even appear in openIds — submitting
  // a disposition for it should land in "invalid" (not found in open infractions),
  // not silently double-write. Confirms the two safety nets don't fight each other.
  const result = (await mondayInfractionReview(ctx(repoRoot), {
    dispositions: [{ infraction_id: "inf-a", decision: "closed", rationale: "again" }],
  })) as any;

  assert.equal(result.dispositions_written, 0);
  assert.equal(readDispositions(repoRoot).length, 1);
});
