import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { scanRepo } from "../capabilities/scanRepo";
import { memoryCheck } from "../capabilities/memoryCheck";
import { Ledger } from "../core/ledger";
import { recordKnownGood } from "../core/knownGood";

function makeRepoRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mk2-scanrepo-test-"));
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "test" }));
  return dir;
}

function ctx(repoRoot: string) {
  return { repoRoot, sessionId: "test-session" } as any;
}

test("scanRepo counts files under repoRoot by default, excluding node_modules/dist/logs/artifacts", async () => {
  const repoRoot = makeRepoRoot();
  fs.writeFileSync(path.join(repoRoot, "a.ts"), "");
  fs.writeFileSync(path.join(repoRoot, "b.ts"), "");
  fs.mkdirSync(path.join(repoRoot, "node_modules", "pkg"), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, "node_modules", "pkg", "index.js"), "");
  fs.mkdirSync(path.join(repoRoot, "dist"), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, "dist", "out.js"), "");

  const result = await scanRepo(ctx(repoRoot));
  // package.json + a.ts + b.ts = 3; node_modules/dist contents excluded.
  assert.equal(result.fileCount, 3);
  assert.equal(result.root, repoRoot);
});

test("scanRepo refuses a targetDir outside repoRoot when no scanAllowedRoots is configured", async () => {
  const repoRoot = makeRepoRoot();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "mk2-scanrepo-outside-"));

  await assert.rejects(() => scanRepo(ctx(repoRoot), { targetDir: outside }), /scan_root_not_allowed/);
});

test("scanRepo allows a targetDir outside repoRoot when explicitly listed in scanAllowedRoots", async () => {
  const repoRoot = makeRepoRoot();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "mk2-scanrepo-allowed-"));
  fs.writeFileSync(path.join(outside, "x.txt"), "");

  fs.mkdirSync(path.join(repoRoot, "config"), { recursive: true });
  fs.writeFileSync(
    path.join(repoRoot, "config", "auernyx.config.json"),
    JSON.stringify({ paths: { scanAllowedRoots: [outside] } })
  );

  const result = await scanRepo(ctx(repoRoot), { targetDir: outside });
  assert.equal(result.fileCount, 1);
});

test(
  "known, documented characteristic (not fixed here, a real design decision not a one-line fix): " +
    "scanRepo follows symlinks during the walk with no per-directory re-check, so a symlink anywhere " +
    "inside an allowed root can make it count files physically outside that root",
  async () => {
    const repoRoot = makeRepoRoot();
    const outsideTarget = fs.mkdtempSync(path.join(os.tmpdir(), "mk2-scanrepo-symlink-target-"));
    fs.writeFileSync(path.join(outsideTarget, "secret1.txt"), "");
    fs.writeFileSync(path.join(outsideTarget, "secret2.txt"), "");

    fs.symlinkSync(outsideTarget, path.join(repoRoot, "escape-link"), "dir");

    const result = await scanRepo(ctx(repoRoot));
    // package.json (1) + the 2 files reached only via the symlink = 3.
    // Pinning the actual current behavior, not endorsing it.
    assert.equal(result.fileCount, 3);
  }
);

test("memoryCheck aggregates both mk2 and kintsugi integrity/policy/knownGood state", async () => {
  const repoRoot = makeRepoRoot();
  fs.mkdirSync(path.join(repoRoot, "config"), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, "config", "allowlist.json"), JSON.stringify({ allowedCapabilities: [] }));
  fs.writeFileSync(path.join(repoRoot, "config", "auernyx.config.json"), JSON.stringify({}));

  const ledger = new Ledger(repoRoot);
  ledger.append("s1", "e1");
  recordKnownGood(repoRoot, { createdBy: "x", reason: "x" });

  const result = (await memoryCheck(ctx(repoRoot))) as any;
  assert.equal(result.ok, true);
  assert.equal(result.mk2.ok, true);
  assert.equal(result.mk2.checkedEntries, 1);
  assert.equal(result.mk2.knownGoodSnapshots, 1);
  assert.equal(result.kintsugi.ok, true);
  assert.equal(typeof result.kintsugi.policyHash, "string");
});

test("memoryCheck reports ok:false overall when either side's integrity check fails", async () => {
  const repoRoot = makeRepoRoot();
  const ledger = new Ledger(repoRoot);
  ledger.append("s1", "e1", { amount: 1 });

  const ledgerPath = path.join(repoRoot, "logs", "ledger.ndjson");
  const lines = fs.readFileSync(ledgerPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  lines[0].data.amount = 999;
  fs.writeFileSync(ledgerPath, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");

  const result = (await memoryCheck(ctx(repoRoot))) as any;
  assert.equal(result.ok, false);
  assert.equal(result.mk2.ok, false);
});

test("memoryCheck respects a maxEntries input for the mk2 ledger check", async () => {
  const repoRoot = makeRepoRoot();
  const ledger = new Ledger(repoRoot);
  for (let i = 0; i < 5; i++) ledger.append("s1", `e${i}`);

  const result = (await memoryCheck(ctx(repoRoot), { maxEntries: 2 })) as any;
  assert.equal(result.mk2.checkedEntries, 2);
});
