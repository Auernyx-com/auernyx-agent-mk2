import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { runGhostVerification } from "../core/kintsugi/ghostVerification";
import { loadConfig } from "../core/config";

// Ghost's threat model (hardcoded in this file) and Mnema's default protected
// paths (core/config.ts's DEFAULT_GOVERNANCE.protectedPaths) are maintained
// in two separate files by design — that's the whole point of the dual-
// witness check, catching drift between them. This test asks loadConfig for
// the real default directly (rather than hand-copying the list into a
// fixture, which would just reintroduce the same two-lists-can-drift problem
// this test exists to guard against) — the same value governanceSelfTest.ts
// actually passes to runGhostVerification in production.
function realDefaultProtectedPaths(): string[] {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mk2-ghost-test-"));
  return loadConfig(repoRoot).governance.protectedPaths;
}

test("Ghost's threat model and Mnema's actual default protectedPaths agree (no drift)", () => {
  const result = runGhostVerification(realDefaultProtectedPaths());
  assert.equal(result.ok, true, `unexpected drift between the two witnesses: ${JSON.stringify(result.deviations)}`);
});

test("a critical path Ghost knows about but Mnema's list drops is a critical deviation", () => {
  const result = runGhostVerification([]); // Mnema tracks nothing
  assert.equal(result.ok, false);
  assert.equal(result.criticalDeviations.length, 3); // all 3 of Ghost's known critical paths
  assert.ok(result.criticalDeviations.every((d) => d.critical && d.inGhostThreatModel && !d.inMnemaList));
});

test("an extra path Mnema protects that Ghost doesn't recognize is a non-critical deviation", () => {
  const result = runGhostVerification([
    ...realDefaultProtectedPaths(),
    "some/custom/protected/path",
  ]);
  assert.equal(result.ok, false);
  assert.equal(result.criticalDeviations.length, 0); // the extra path isn't critical
  const extra = result.deviations.find((d) => d.path === "some/custom/protected/path");
  assert.ok(extra);
  assert.equal(extra!.critical, false);
});

test("path comparison is case/slash-normalized and works with either as the more specific parent", () => {
  const result = runGhostVerification([".AUERNYX/Kintsugi/Ledger/Records"]);
  // Only the ledger-records deviation should be resolved by the differently-cased match;
  // the other two Ghost paths are still missing from this short list.
  assert.equal(result.deviations.some((d) => d.path === ".auernyx/kintsugi/ledger/records"), false);
});

// Item 5 (2026-11-27 /code-review high): Mnema's list is enforced by prefix
// (governanceRefusal.isPathProtected: rel === p || rel.startsWith(p + "/")),
// so an entry only protects its own subtree. A NARROWER child entry does not
// protect the parent Ghost cares about, and must not count as coverage.
test("a narrower child entry in Mnema's list does NOT count as covering Ghost's parent threat path", () => {
  const result = runGhostVerification([
    ".auernyx/kintsugi/ledger/records/2026", // child of the ledger-records threat only
    ".auernyx/kintsugi/policy/history",
    ".auernyx/kintsugi/policy/active.policy.json",
  ]);
  const ledger = result.deviations.find((d) => d.path === ".auernyx/kintsugi/ledger/records");
  assert.ok(ledger, "ledger/records is only partly protected: Ghost must report it missing");
  assert.equal(ledger!.critical, true);
  assert.equal(ledger!.inMnemaList, false);
});

test("a broader parent entry in Mnema's list still covers every Ghost threat path under it", () => {
  const result = runGhostVerification([".auernyx/kintsugi"]);
  assert.equal(result.deviations.filter((d) => d.inGhostThreatModel).length, 0);
});

// Item 7 (2026-11-27 /code-review high): the default protectedPaths entry and
// Ghost's threat model both named .auernyx/kintsugi/active.policy.json, one
// folder short of the file Kintsugi actually writes
// (core/kintsugi/memory.ts: .auernyx/kintsugi/policy/active.policy.json).
// They agreed with each other, so Ghost never flagged it, while Mnema's
// config-list witness (prefix match) did not cover the real file at all.
const REAL_ACTIVE_POLICY = ".auernyx/kintsugi/policy/active.policy.json";
const prefixCovers = (entries: readonly string[], rel: string) =>
  entries.some((p) => rel === p || rel.startsWith(p + "/"));

test("Mnema's default protectedPaths cover the REAL active policy file by prefix (not just via the hard-coded fallback)", () => {
  assert.ok(prefixCovers(realDefaultProtectedPaths(), REAL_ACTIVE_POLICY), `defaults: ${realDefaultProtectedPaths().join(", ")}`);
});

test("Ghost flags a Mnema list that protects everything except the real active policy file", () => {
  const result = runGhostVerification([".auernyx/kintsugi/ledger/records", ".auernyx/kintsugi/policy/history"]);
  const missing = result.deviations.find((d) => d.inGhostThreatModel && d.path === REAL_ACTIVE_POLICY);
  assert.ok(missing, `Ghost should name ${REAL_ACTIVE_POLICY}: ${JSON.stringify(result.deviations.map((d) => d.path))}`);
  assert.equal(missing!.critical, true);
});
