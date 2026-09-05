import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import process from "node:process";
import {
  getSkjoldrFirewallStatus,
  parseSkjoldrJson,
  verifyBaselineSnapshot,
  runSkjoldrCommand,
  runSkjoldrJsonCommand,
} from "../core/skjoldrFirewall";

function makeRepoRoot(addonConfig?: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mk2-skjoldr-test-"));
  if (addonConfig !== undefined) {
    fs.mkdirSync(path.join(dir, "config"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "config", "auernyx.config.json"),
      JSON.stringify({ addons: { skjoldrFirewall: addonConfig } })
    );
  }
  return dir;
}

test("getSkjoldrFirewallStatus reports disabled and unavailable when the addon isn't enabled", () => {
  const status = getSkjoldrFirewallStatus(makeRepoRoot());
  assert.equal(status.enabled, false);
  assert.equal(status.available, false);
});

test("getSkjoldrFirewallStatus uses an explicitly configured command as-is", () => {
  const repoRoot = makeRepoRoot({ enabled: true, command: "python3" });
  const status = getSkjoldrFirewallStatus(repoRoot);
  assert.equal(status.available, true);
  assert.equal(status.resolvedCommand, "python3");
});

test("getSkjoldrFirewallStatus auto-detects a known candidate filename in the configured path", () => {
  const repoRoot = makeRepoRoot();
  const skjoldrDir = path.join(repoRoot, "skjoldr-firewall");
  fs.mkdirSync(skjoldrDir, { recursive: true });
  fs.writeFileSync(path.join(skjoldrDir, "SkjoldrCLI.py"), "# not a real candidate name");
  fs.writeFileSync(path.join(skjoldrDir, "skjoldr.cmd"), "@echo off");

  fs.mkdirSync(path.join(repoRoot, "config"), { recursive: true });
  fs.writeFileSync(
    path.join(repoRoot, "config", "auernyx.config.json"),
    JSON.stringify({ addons: { skjoldrFirewall: { enabled: true, path: skjoldrDir } } })
  );

  const status = getSkjoldrFirewallStatus(repoRoot);
  assert.equal(status.available, true);
  assert.equal(status.resolvedCommand, path.join(skjoldrDir, "skjoldr.cmd"));
});

test("getSkjoldrFirewallStatus treats a path pointing directly at an existing file as the command", () => {
  const repoRoot = makeRepoRoot();
  const scriptPath = path.join(repoRoot, "my-custom-skjoldr.sh");
  fs.writeFileSync(scriptPath, "#!/bin/sh\necho hi\n");

  fs.mkdirSync(path.join(repoRoot, "config"), { recursive: true });
  fs.writeFileSync(
    path.join(repoRoot, "config", "auernyx.config.json"),
    JSON.stringify({ addons: { skjoldrFirewall: { enabled: true, path: scriptPath } } })
  );

  const status = getSkjoldrFirewallStatus(repoRoot);
  assert.equal(status.resolvedCommand, scriptPath);
});

test("getSkjoldrFirewallStatus with allowAutoDetect: false never resolves a command from a bare path", () => {
  const repoRoot = makeRepoRoot();
  const skjoldrDir = path.join(repoRoot, "skjoldr-firewall");
  fs.mkdirSync(skjoldrDir, { recursive: true });
  fs.writeFileSync(path.join(skjoldrDir, "skjoldr.cmd"), "@echo off");

  fs.mkdirSync(path.join(repoRoot, "config"), { recursive: true });
  fs.writeFileSync(
    path.join(repoRoot, "config", "auernyx.config.json"),
    JSON.stringify({ addons: { skjoldrFirewall: { enabled: true, path: skjoldrDir } } })
  );

  const status = getSkjoldrFirewallStatus(repoRoot, { allowAutoDetect: false });
  assert.equal(status.available, false);
});

test("parseSkjoldrJson accepts a well-formed envelope and rejects everything else", () => {
  assert.deepEqual(parseSkjoldrJson('{"ok": true, "data": {"x": 1}}'), { ok: true, data: { x: 1 } });
  assert.throws(() => parseSkjoldrJson(""), /no stdout/);
  assert.throws(() => parseSkjoldrJson("not json"), /not valid JSON/);
  assert.throws(() => parseSkjoldrJson("42"), /not an object/);
  assert.throws(() => parseSkjoldrJson('{"data": {}}'), /missing required boolean field/);
});

test("verifyBaselineSnapshot detects a missing file, a hash mismatch, and a correct match (case-insensitive)", () => {
  const repoRoot = makeRepoRoot();
  const filePath = path.join(repoRoot, "baseline.json");
  fs.writeFileSync(filePath, "content");

  const crypto = require("crypto");
  const realHash = crypto.createHash("sha256").update("content").digest("hex");

  assert.equal(verifyBaselineSnapshot(path.join(repoRoot, "missing.json"), realHash).ok, false);
  assert.equal(verifyBaselineSnapshot(filePath, "0".repeat(64)).ok, false);
  assert.equal(verifyBaselineSnapshot(filePath, realHash.toUpperCase()).ok, true);
});

test("runSkjoldrCommand captures stdout and a zero exit code for a real subprocess", async () => {
  const result = await runSkjoldrCommand(
    process.execPath,
    ["-e", "process.stdout.write(JSON.stringify({ok: true}))"],
    5000
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout.trim(), '{"ok":true}');
});

test("runSkjoldrJsonCommand throws with stderr content on a non-zero exit", async () => {
  await assert.rejects(
    () =>
      runSkjoldrJsonCommand(
        process.execPath,
        ["-e", "process.stderr.write('boom'); process.exit(1)"],
        5000
      ),
    /boom/
  );
});

test("runSkjoldrCommand rejects on timeout for a subprocess that never exits", async () => {
  await assert.rejects(
    () => runSkjoldrCommand(process.execPath, ["-e", "setInterval(() => {}, 1000)"], 200),
    /timed out/
  );
});
