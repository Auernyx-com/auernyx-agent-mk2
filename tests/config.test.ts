import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { loadConfig } from "../core/config";

// First direct unit coverage for config.ts — loadConfig underlies almost
// every governance decision in the router (writeEnabled, approverIdentity,
// riskTolerance, protectedPaths), but had no tests of its own defaulting/
// sanitization logic in isolation.

function makeRepoRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mk2-config-test-"));
}

function writeConfig(repoRoot: string, config: unknown): void {
  fs.mkdirSync(path.join(repoRoot, "config"), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, "config", "auernyx.config.json"), JSON.stringify(config));
}

// loadConfig caches by (file path, mtime). Every test uses a fresh temp repo
// root via makeRepoRoot(), so each gets a distinct file path — the module-
// level cache never sees the same path twice across tests.

test("returns sane defaults when no config file exists", () => {
  const cfg = loadConfig(makeRepoRoot());
  assert.equal(cfg.daemon.port, 43117);
  assert.equal(cfg.governance.approverIdentity, "");
  assert.equal(cfg.governance.riskTolerance, "WITHIN_TOLERANCE");
  assert.deepEqual(cfg.paths.scanAllowedRoots, []);
  assert.equal(cfg.addons.skjoldrFirewall.enabled, false);
});

test("returns sane defaults for a corrupted config file, rather than throwing", () => {
  const repoRoot = makeRepoRoot();
  fs.mkdirSync(path.join(repoRoot, "config"), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, "config", "auernyx.config.json"), "{not valid json");

  const cfg = loadConfig(repoRoot);
  assert.equal(cfg.governance.riskTolerance, "WITHIN_TOLERANCE");
});

test("a real config file's values are read through correctly", () => {
  const repoRoot = makeRepoRoot();
  writeConfig(repoRoot, {
    governance: { approverIdentity: "Justin Hughes", riskTolerance: "controlled" },
    daemon: { port: 9999 },
    addons: { skjoldrFirewall: { enabled: true, command: "python3" } },
  });

  const cfg = loadConfig(repoRoot);
  assert.equal(cfg.governance.approverIdentity, "Justin Hughes");
  assert.equal(cfg.governance.riskTolerance, "CONTROLLED"); // normalized to uppercase
  assert.equal(cfg.daemon.port, 9999);
  assert.equal(cfg.addons.skjoldrFirewall.enabled, true);
  assert.equal(cfg.addons.skjoldrFirewall.command, "python3");
});

test("an invalid riskTolerance value falls back to WITHIN_TOLERANCE, not left as-is", () => {
  const repoRoot = makeRepoRoot();
  writeConfig(repoRoot, { governance: { riskTolerance: "NONSENSE" } });
  assert.equal(loadConfig(repoRoot).governance.riskTolerance, "WITHIN_TOLERANCE");
});

test("a non-positive or non-numeric port falls back to the default rather than being used as-is", () => {
  const repoRoot1 = makeRepoRoot();
  writeConfig(repoRoot1, { daemon: { port: -1 } });
  assert.equal(loadConfig(repoRoot1).daemon.port, 43117);

  const repoRoot2 = makeRepoRoot();
  writeConfig(repoRoot2, { daemon: { port: "not-a-number" } });
  assert.equal(loadConfig(repoRoot2).daemon.port, 43117);
});

test("AUERNYX_WRITE_ENABLED env var overrides the config file's writeEnabled value in both directions", () => {
  const repoRoot = makeRepoRoot();
  writeConfig(repoRoot, { writeEnabled: true });

  const original = process.env.AUERNYX_WRITE_ENABLED;
  try {
    process.env.AUERNYX_WRITE_ENABLED = "0";
    assert.equal(loadConfig(repoRoot + "/x1").writeEnabled, false); // distinct path to dodge the cache

    fs.mkdirSync(repoRoot + "/x2/config", { recursive: true });
    fs.writeFileSync(repoRoot + "/x2/config/auernyx.config.json", JSON.stringify({ writeEnabled: false }));
    process.env.AUERNYX_WRITE_ENABLED = "1";
    assert.equal(loadConfig(repoRoot + "/x2").writeEnabled, true);
  } finally {
    if (original === undefined) delete process.env.AUERNYX_WRITE_ENABLED;
    else process.env.AUERNYX_WRITE_ENABLED = original;
  }
});

test("protectedPaths from config are normalized (backslashes to forward slashes, trimmed, blanks dropped)", () => {
  const repoRoot = makeRepoRoot();
  writeConfig(repoRoot, {
    governance: { protectedPaths: ["some\\windows\\path", "  spaced  ", "", "   "] },
  });
  assert.deepEqual(loadConfig(repoRoot).governance.protectedPaths, ["some/windows/path", "spaced"]);
});

test("scanAllowedRoots filters out non-string and blank entries", () => {
  const repoRoot = makeRepoRoot();
  writeConfig(repoRoot, { paths: { scanAllowedRoots: ["/real/path", "", 42, "  ", "/another"] } });
  assert.deepEqual(loadConfig(repoRoot).paths.scanAllowedRoots, ["/real/path", "/another"]);
});

test("loadConfig picks up a real file change once the mtime actually differs", async () => {
  const repoRoot = makeRepoRoot();
  writeConfig(repoRoot, { daemon: { port: 1111 } });
  assert.equal(loadConfig(repoRoot).daemon.port, 1111);

  // loadConfig caches by (file path, mtime): a rewrite needs a different
  // mtime to actually invalidate the cache, not just different content.
  await new Promise((r) => setTimeout(r, 10));
  writeConfig(repoRoot, { daemon: { port: 2222 } });
  assert.equal(loadConfig(repoRoot).daemon.port, 2222);
});
