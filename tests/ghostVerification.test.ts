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
