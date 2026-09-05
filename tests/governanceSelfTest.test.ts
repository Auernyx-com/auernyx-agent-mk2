import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { governanceSelfTest } from "../capabilities/governanceSelfTest";
import { readGovernanceLock } from "../core/governanceLock";

function makeRepoRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mk2-selftest-test-"));
  fs.writeFileSync(dir + "/package.json", JSON.stringify({ name: "test" }));
  return dir;
}

function makeCtx(repoRoot: string) {
  return { repoRoot, sessionId: "test-session" } as any;
}

test("a healthy repo passes the self-test: tripwire refused correctly, no deviations, lock cleared", async () => {
  const repoRoot = makeRepoRoot();
  const result = (await governanceSelfTest(makeCtx(repoRoot))) as any;

  assert.equal(result.ok, true);
  assert.equal(result.refusal.refusalReason, "LEDGER_PROTECTION"); // the tripwire write was correctly blocked
  assert.equal(result.ghostVerification, undefined); // no dual-witness deviation
  assert.equal(readGovernanceLock(repoRoot).locked, false);
});

test("the tripwire write never actually lands on disk, even though the guard is expected to block it", async () => {
  const repoRoot = makeRepoRoot();
  await governanceSelfTest(makeCtx(repoRoot));
  const illegalTarget = path.join(repoRoot, ".auernyx", "kintsugi", "ledger", "records", "SELFTEST_DO_NOT_WRITE.txt");
  assert.equal(fs.existsSync(illegalTarget), false);
});

test("a self-test run seals a real Kintsugi refusal record for the tripwire attempt", async () => {
  const repoRoot = makeRepoRoot();
  await governanceSelfTest(makeCtx(repoRoot));

  const recordsDir = path.join(repoRoot, ".auernyx", "kintsugi", "ledger", "records");
  const files = fs.readdirSync(recordsDir).filter((f) => f.endsWith(".json"));
  const records = files.map((f) => JSON.parse(fs.readFileSync(path.join(recordsDir, f), "utf8")));
  assert.ok(records.some((r) => r.record_kind === "MRR" && r.refusal_reason === "LEDGER_PROTECTION"));
});

test("if ledger integrity is already broken before the test runs, it locks immediately without running the tripwire", async () => {
  const repoRoot = makeRepoRoot();
  await governanceSelfTest(makeCtx(repoRoot)); // establish a real ledger with one entry

  const recordsDir = path.join(repoRoot, ".auernyx", "kintsugi", "ledger", "records");
  const files = fs.readdirSync(recordsDir).filter((f) => f.endsWith(".json"));
  const victim = JSON.parse(fs.readFileSync(path.join(recordsDir, files[0]), "utf8"));
  victim.requested_action = "TAMPERED";
  fs.writeFileSync(path.join(recordsDir, files[0]), JSON.stringify(victim));

  const result = (await governanceSelfTest(makeCtx(repoRoot))) as any;
  assert.equal(result.ok, false);
  assert.equal(result.lock.locked, true);
  assert.ok(result.lock.reason.includes("hash chain"));
  assert.equal(result.refusal, undefined); // never reached the tripwire step
  assert.equal(readGovernanceLock(repoRoot).locked, true);
});

test("an existing, more specific lock reason is preserved rather than overwritten by a generic one", async () => {
  const repoRoot = makeRepoRoot();
  await governanceSelfTest(makeCtx(repoRoot));

  const recordsDir = path.join(repoRoot, ".auernyx", "kintsugi", "ledger", "records");
  const files = fs.readdirSync(recordsDir).filter((f) => f.endsWith(".json"));
  const victim = JSON.parse(fs.readFileSync(path.join(recordsDir, files[0]), "utf8"));
  victim.requested_action = "TAMPERED";
  fs.writeFileSync(path.join(recordsDir, files[0]), JSON.stringify(victim));

  const first = (await governanceSelfTest(makeCtx(repoRoot))) as any;
  const second = (await governanceSelfTest(makeCtx(repoRoot))) as any;
  assert.equal(second.lock.reason, first.lock.reason);
});

test("a custom protectedPaths config replaces (not merges with) the defaults — Ghost then flags all 3 dropped critical paths", async () => {
  // loadConfig's governance.protectedPaths is replace-not-merge (see
  // core/config.ts): supplying any array drops the 3 default critical
  // paths entirely unless the custom list repeats them. Documenting the
  // actual observed effect on the dual-witness check, not just the
  // intended one (a locally-added custom path).
  const repoRoot = makeRepoRoot();
  fs.mkdirSync(path.join(repoRoot, "config"), { recursive: true });
  fs.writeFileSync(
    path.join(repoRoot, "config", "auernyx.config.json"),
    JSON.stringify({ governance: { protectedPaths: ["custom/extra/path"] } })
  );

  const result = (await governanceSelfTest(makeCtx(repoRoot))) as any;
  assert.equal(result.ok, false);
  assert.equal(result.ghostVerification.deviations.length, 4); // 3 dropped critical + 1 unrecognized extra
  assert.ok(result.ghostVerification.deviations.some((d: any) => d.path === "custom/extra/path" && !d.critical));
});
