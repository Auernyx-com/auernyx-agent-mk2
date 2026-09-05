import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// A real, directly-spawnable stand-in for the Skjoldr CLI, used by every
// skjoldrFirewall* capability test. Written as a shebang'd script (not
// invoked via `node script.js`) because these capabilities pass Skjoldr's
// own CLI-style argv (`export --json --timeout 15000`, `apply --profile x
// --dry-run ...`) straight through to whatever `resolvedCommand` is —
// `node <that argv>` would try to load "export" as a module and fail. A
// real executable file sidesteps that entirely, same as a real CLI would
// be spawned.
//
// Behavior: always returns { ok: true, data: { verb, args } } unless the
// FAKE_SKJOLDR_FAIL_VERB env var names the current invocation's verb, in
// which case it returns { ok: false, error_code, message } instead — lets
// a single fake CLI cover both success and failure paths. `export`
// additionally writes a real snapshot file and reports its path/hash, since
// skjoldrFirewallExportBaseline requires that file to actually exist on disk.
export function makeFakeSkjoldrCli(baseDir: string): string {
  const scriptPath = path.join(baseDir, "fake-skjoldr-cli.js");
  const body = `#!/usr/bin/env node
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const verb = process.argv[2];
const failVerb = process.env.FAKE_SKJOLDR_FAIL_VERB;

if (verb && verb === failVerb) {
  process.stdout.write(JSON.stringify({
    ok: false,
    error_code: "FAKE_FORCED_FAILURE",
    message: \`forced failure for verb: \${verb}\`,
  }));
  process.exit(0);
}

if (verb === "export") {
  const snapshotPath = path.join(os.tmpdir(), \`fake-skjoldr-snapshot-\${Date.now()}-\${Math.random().toString(36).slice(2)}.json\`);
  const content = JSON.stringify({ zones: [], exportedAt: new Date().toISOString() });
  fs.writeFileSync(snapshotPath, content);
  const hash = crypto.createHash("sha256").update(content).digest("hex");
  process.stdout.write(JSON.stringify({
    ok: true,
    data: { verb, args: process.argv.slice(2), snapshot_path: snapshotPath, hash },
  }));
  process.exit(0);
}

process.stdout.write(JSON.stringify({ ok: true, data: { verb, args: process.argv.slice(2) } }));
process.exit(0);
`;
  fs.writeFileSync(scriptPath, body, { mode: 0o755 });
  return scriptPath;
}

export function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// A repo root with the Skjoldr addon enabled and pointed at a fake CLI —
// shared setup every skjoldrFirewall* capability test needs.
export function makeSkjoldrRepoRoot(prefix: string): { repoRoot: string; fakeCliPath: string } {
  const repoRoot = makeTempDir(prefix);
  const fakeCliPath = makeFakeSkjoldrCli(repoRoot);
  fs.mkdirSync(path.join(repoRoot, "config"), { recursive: true });
  fs.writeFileSync(
    path.join(repoRoot, "config", "auernyx.config.json"),
    JSON.stringify({
      addons: {
        skjoldrFirewall: {
          enabled: true,
          command: fakeCliPath,
          json: true,
          timeoutMs: 5000,
        },
      },
    })
  );
  return { repoRoot, fakeCliPath };
}
