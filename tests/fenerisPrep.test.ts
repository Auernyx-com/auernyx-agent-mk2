import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { fenerisPrep } from "../capabilities/fenerisPrep";

// fenerisPrep is a thin wrapper around runSentinelScan (already extensively
// covered in tests/feneris.test.ts) — confirms the wrapper actually
// delegates to the real scan against the real repoRoot/sessionId, not a
// stub or a different scan.

test("fenerisPrep runs a real sentinel scan against the given repoRoot and sessionId", async () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mk2-fenerisprep-test-"));
  const result = (await fenerisPrep({ repoRoot, sessionId: "session-xyz" } as any)) as any;

  assert.equal(result.session_id, "session-xyz");
  assert.equal(typeof result.infractions_raised, "number");
  assert.ok(Array.isArray(result.infractions));
  assert.ok(result.constraints_honored.includes("FENERIS.NO_AUTONOMOUS_ENFORCEMENT"));
});
