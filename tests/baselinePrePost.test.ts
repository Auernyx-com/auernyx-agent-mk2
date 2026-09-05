import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { baselinePre } from "../capabilities/baselinePre";
import { baselinePost } from "../capabilities/baselinePost";
import { Ledger } from "../core/ledger";

function makeRepoRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mk2-baseline-test-"));
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "test" }));
  fs.mkdirSync(path.join(dir, "config"), { recursive: true });
  fs.writeFileSync(path.join(dir, "config", "allowlist.json"), JSON.stringify({ allowedCapabilities: [] }));
  fs.writeFileSync(path.join(dir, "config", "auernyx.config.json"), JSON.stringify({}));
  return dir;
}

function ctx(repoRoot: string) {
  return { repoRoot, sessionId: "test-session" } as any;
}

test("baselinePre creates both a core knownGood entry and a kintsugi snapshot, linked by the same kgsId", async () => {
  const repoRoot = makeRepoRoot();
  const result = (await baselinePre(ctx(repoRoot), { reason: "before risky change", createdBy: "Justin Hughes" })) as any;

  assert.equal(result.entry.reason, "before risky change");
  assert.equal(result.kintsugiEntry.reason, "before risky change");
  assert.equal(result.entry.kgsId, result.kintsugiEntry.kgs_id);
  assert.equal(result.kintsugiEntry.created_by, "Justin Hughes"); // plain text, not hashed — see the created_by fix (PR #168)
});

test("baselinePre defaults reason and createdBy sensibly when neither is given", async () => {
  const repoRoot = makeRepoRoot();
  const result = (await baselinePre(ctx(repoRoot), {})) as any;
  assert.equal(result.entry.reason, "baselinePre");
  assert.equal(result.entry.createdBy, "human");
});

test("baselinePre anchors to the current ledger tail hash when a ledger already exists", async () => {
  const repoRoot = makeRepoRoot();
  const ledger = new Ledger(repoRoot);
  const entry = ledger.append("s1", "some.event");

  const result = (await baselinePre(ctx(repoRoot), {})) as any;
  assert.equal(result.entry.ledgerHeadHash, entry.hash);
});

test("baselinePost reports ok:true for a healthy ledger with checked entry count", async () => {
  const repoRoot = makeRepoRoot();
  const ledger = new Ledger(repoRoot);
  ledger.append("s1", "e1");
  ledger.append("s1", "e2");

  const result = (await baselinePost(ctx(repoRoot))) as any;
  assert.equal(result.ok, true);
  assert.equal(result.checkedEntries, 2);
  assert.deepEqual(result.warnings, []);
});

test("baselinePost reports ok:false with warnings for a tampered ledger", async () => {
  const repoRoot = makeRepoRoot();
  const ledger = new Ledger(repoRoot);
  ledger.append("s1", "e1", { amount: 100 });

  const ledgerPath = path.join(repoRoot, "logs", "ledger.ndjson");
  const lines = fs.readFileSync(ledgerPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  lines[0].data.amount = 999;
  fs.writeFileSync(ledgerPath, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");

  const result = (await baselinePost(ctx(repoRoot))) as any;
  assert.equal(result.ok, false);
  assert.ok(result.warnings.length > 0);
});

test("baselinePost is trivially ok:true (empty chain) when there's no ledger at all yet", async () => {
  const result = (await baselinePost(ctx(makeRepoRoot()))) as any;
  assert.equal(result.ok, true);
  assert.equal(result.checkedEntries, 0);
});
