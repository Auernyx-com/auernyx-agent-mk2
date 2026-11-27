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
  buildSkjoldrSpawnSpec,
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
  fs.writeFileSync(path.join(skjoldrDir, "SkjoldrCLI.py"), "# the real Linux entry point");
  fs.writeFileSync(path.join(skjoldrDir, "skjoldr.cmd"), "@echo off");

  fs.mkdirSync(path.join(repoRoot, "config"), { recursive: true });
  fs.writeFileSync(
    path.join(repoRoot, "config", "auernyx.config.json"),
    JSON.stringify({ addons: { skjoldrFirewall: { enabled: true, path: skjoldrDir } } })
  );

  const status = getSkjoldrFirewallStatus(repoRoot);
  // Windows prefers the .cmd launcher; elsewhere a .cmd can't run, so the
  // Python CLI is picked. (Before item 8 this resolved skjoldr.cmd on Linux
  // too and reported it available.)
  const expected = process.platform === "win32" ? "skjoldr.cmd" : "SkjoldrCLI.py";
  assert.equal(status.resolvedCommand, path.join(skjoldrDir, expected));
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

// ── Item 8 (2026-11-27 /code-review high): launching .cmd / .ps1 / .py ──
// Before: .ps1 always went to powershell.exe (absent off Windows), .cmd was
// spawned directly (Node refuses .cmd/.bat without a shell since its April
// 2024 security release), and the status check said "available" anyway.

test("buildSkjoldrSpawnSpec: .ps1 uses powershell.exe on Windows and pwsh elsewhere", () => {
  const win = buildSkjoldrSpawnSpec("C:\\sk\\SkjoldrCLI.ps1", ["status", "--json"], "win32");
  assert.equal(win.file, "powershell.exe");
  assert.deepEqual(win.args, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "C:\\sk\\SkjoldrCLI.ps1", "status", "--json"]);
  assert.equal(buildSkjoldrSpawnSpec("/opt/sk/SkjoldrCLI.ps1", ["status"], "linux").file, "pwsh");
});

test("buildSkjoldrSpawnSpec: .cmd on Windows goes through cmd.exe with every piece quoted, verbatim", () => {
  const spec = buildSkjoldrSpawnSpec("C:\\Program Files (x86)\\sk\\skjoldr.cmd", ["apply", "--file", "C:\\rules (1).json"], "win32");
  assert.equal(spec.file, "cmd.exe");
  assert.equal(spec.windowsVerbatimArguments, true);
  assert.deepEqual(spec.args, ["/d", "/s", "/c", '""C:\\Program Files (x86)\\sk\\skjoldr.cmd" "apply" "--file" "C:\\rules (1).json""']);
});

test("buildSkjoldrSpawnSpec: .cmd refuses any argument cmd.exe would interpret (injection guard)", () => {
  for (const bad of ["a&calc", "a|b", "a>b", "a<b", "a^b", "%PATH%", "a!b", 'a"b', "a\nb"]) {
    assert.throws(() => buildSkjoldrSpawnSpec("C:\\sk\\skjoldr.cmd", ["status", bad], "win32"), /Refusing to pass/, bad);
  }
});

test("buildSkjoldrSpawnSpec: .cmd / .bat cannot run off Windows", () => {
  assert.throws(() => buildSkjoldrSpawnSpec("/opt/sk/skjoldr.cmd", ["status"], "linux"), /Cannot run a \.cmd file on linux/);
  assert.throws(() => buildSkjoldrSpawnSpec("/opt/sk/skjoldr.bat", ["status"], "darwin"), /Cannot run a \.bat file on darwin/);
});

test("buildSkjoldrSpawnSpec: .py runs under python3 (python on Windows); anything else runs directly", () => {
  assert.deepEqual(buildSkjoldrSpawnSpec("/opt/sk/SkjoldrCLI.py", ["status"], "linux"), { file: "python3", args: ["/opt/sk/SkjoldrCLI.py", "status"] });
  assert.equal(buildSkjoldrSpawnSpec("C:\\sk\\SkjoldrCLI.py", ["status"], "win32").file, "python");
  assert.deepEqual(buildSkjoldrSpawnSpec("/usr/bin/skjoldr", ["status"], "linux"), { file: "/usr/bin/skjoldr", args: ["status"] });
});

test("status: a resolved .ps1 is NOT available when its PowerShell interpreter isn't on PATH", () => {
  const repoRoot = makeRepoRoot();
  const script = path.join(repoRoot, "SkjoldrCLI.ps1");
  fs.writeFileSync(script, "# ps1");
  fs.mkdirSync(path.join(repoRoot, "config"), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, "config", "auernyx.config.json"), JSON.stringify({ addons: { skjoldrFirewall: { enabled: true, path: script } } }));

  const emptyBin = fs.mkdtempSync(path.join(os.tmpdir(), "mk2-empty-path-"));
  const savedPath = process.env.PATH;
  process.env.PATH = emptyBin;
  try {
    const status = getSkjoldrFirewallStatus(repoRoot);
    assert.equal(status.resolvedCommand, script);
    assert.equal(status.available, false);
    assert.ok(status.notes.some((n) => /Needs '(pwsh|powershell\.exe)' on PATH/.test(n)), status.notes.join(" | "));
  } finally {
    process.env.PATH = savedPath;
  }
});

test("status: a configured .cmd is NOT available off Windows", { skip: process.platform === "win32" }, () => {
  const repoRoot = makeRepoRoot();
  const script = path.join(repoRoot, "skjoldr.cmd");
  fs.writeFileSync(script, "@echo off");
  fs.mkdirSync(path.join(repoRoot, "config"), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, "config", "auernyx.config.json"), JSON.stringify({ addons: { skjoldrFirewall: { enabled: true, path: script } } }));

  const status = getSkjoldrFirewallStatus(repoRoot);
  assert.equal(status.available, false);
  assert.ok(status.notes.some((n) => /Cannot run a \.cmd file/.test(n)), status.notes.join(" | "));
});

test("end to end: an auto-detected SkjoldrCLI.py really runs under python3 and returns the JSON envelope", { skip: process.platform === "win32" }, async () => {
  const repoRoot = makeRepoRoot();
  const dir = path.join(repoRoot, "skjoldr-firewall");
  fs.mkdirSync(dir, { recursive: true });
  // Same contract as the real SkjoldrCLI.py: verb first, JSON {ok, data} on stdout.
  fs.writeFileSync(
    path.join(dir, "SkjoldrCLI.py"),
    'import json, sys\nprint(json.dumps({"ok": True, "data": {"verb": sys.argv[1], "args": sys.argv[2:]}}))\n'
  );
  fs.mkdirSync(path.join(repoRoot, "config"), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, "config", "auernyx.config.json"), JSON.stringify({ addons: { skjoldrFirewall: { enabled: true, path: dir } } }));

  const status = getSkjoldrFirewallStatus(repoRoot);
  assert.equal(status.available, true, status.notes.join(" | "));
  const env = await runSkjoldrJsonCommand(status.resolvedCommand!, ["status", "--json"], 10_000);
  assert.equal(env.ok, true);
  assert.deepEqual((env as any).data, { verb: "status", args: ["--json"] });
});
