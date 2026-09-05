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

// (the fix) fenerisPrep is tiered readOnly:true in policy.ts — correct, it's
// a pure monitor that never enforces anything — which means the router's
// own write_disabled gate (!cfg.writeEnabled && !meta.readOnly) never
// applies to it. That's fine for the monitoring itself, but this capability
// used to write to disk (via runSentinelScan -> appendInfraction)
// completely unconditionally, bypassing writeEnabled:false — the documented
// "read-only by default" global switch — entirely. Found via an independent
// review pass, then verified directly: called with writeEnabled:false and
// no approval identity anywhere, it still wrote infraction files to disk
// and returned ok:true with a receipt claiming OK_PREVIEW_ONLY.
test("(the fix) fenerisPrep respects writeEnabled:false read from config — reports findings, writes nothing", async () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mk2-fenerisprep-writegate-test-"));
  fs.mkdirSync(path.join(repoRoot, "config"), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, "config", "auernyx.config.json"), JSON.stringify({ writeEnabled: false }));

  const infractionsPath = path.join(repoRoot, ".auernyx", "feneris", "infractions.ndjson");
  const result = (await fenerisPrep({ repoRoot, sessionId: "session-xyz" } as any)) as any;

  // Detection still happens and is reported — this is about persistence, not silencing the monitor.
  assert.ok(result.infractions_raised > 0);
  assert.equal(fs.existsSync(infractionsPath), false);
});

test("(the fix) fenerisPrep writes normally when writeEnabled:true", async () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mk2-fenerisprep-writegate-test-2-"));
  fs.mkdirSync(path.join(repoRoot, "config"), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, "config", "auernyx.config.json"), JSON.stringify({ writeEnabled: true }));

  const infractionsPath = path.join(repoRoot, ".auernyx", "feneris", "infractions.ndjson");
  const result = (await fenerisPrep({ repoRoot, sessionId: "session-xyz" } as any)) as any;

  assert.ok(result.infractions_raised > 0);
  assert.equal(fs.existsSync(infractionsPath), true);
});
