import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { governanceSelfTest } from "../capabilities/governanceSelfTest";
import { governanceUnlock } from "../capabilities/governanceUnlock";
import { readGovernanceLock } from "../core/governanceLock";

// 2026-11-27 Kintsugi fail-closed plan, step 2. governanceUnlock cleared the
// lock on one check only: the main audit ledger's hash chain
// (logs/ledger.ndjson). It never looked at what tripped the lock. Only the
// self-test trips it, on three things: the Kintsugi ledger failing its
// integrity check, the protected-path tripwire not being refused, or a
// critical Ghost dual-witness deviation. None of those live in the audit
// ledger, so unlock cleared every one of them while the cause was still
// there. A lock must never clear while its cause is still there.

function makeRepoRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mk2-unlock-test-"));
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "test" }));
  return dir;
}

type LedgerEvent = { event: string; data: any };

function makeCtx(repoRoot: string, events: LedgerEvent[] = []) {
  return {
    repoRoot,
    sessionId: "test-session",
    ledger: { append: (_sessionId: string, event: string, data: unknown) => events.push({ event, data }) },
  } as any;
}

function tamperKintsugiLedger(repoRoot: string) {
  const recordsDir = path.join(repoRoot, ".auernyx", "kintsugi", "ledger", "records");
  const files = fs.readdirSync(recordsDir).filter((f) => f.endsWith(".json"));
  const victim = JSON.parse(fs.readFileSync(path.join(recordsDir, files[0]), "utf8"));
  victim.requested_action = "TAMPERED";
  fs.writeFileSync(path.join(recordsDir, files[0]), JSON.stringify(victim));
}

// A custom protectedPaths list replaces the defaults, so leaving out one of
// Ghost's critical paths produces a real critical dual-witness deviation.
function dropCriticalProtectedPath(repoRoot: string) {
  fs.mkdirSync(path.join(repoRoot, "config"), { recursive: true });
  fs.writeFileSync(
    path.join(repoRoot, "config", "auernyx.config.json"),
    JSON.stringify({
      governance: {
        protectedPaths: [".auernyx/kintsugi/ledger/records", ".auernyx/kintsugi/policy/active.policy.json"],
      },
    })
  );
}

function restoreDefaultConfig(repoRoot: string) {
  fs.rmSync(path.join(repoRoot, "config", "auernyx.config.json"));
}

test("unlock refuses while the Kintsugi ledger is still tampered (the cause of the lock)", async () => {
  const repoRoot = makeRepoRoot();
  await governanceSelfTest(makeCtx(repoRoot)); // establish a real Kintsugi ledger
  tamperKintsugiLedger(repoRoot);
  await governanceSelfTest(makeCtx(repoRoot));
  const lockedWith = readGovernanceLock(repoRoot);
  assert.equal(lockedWith.locked, true);

  const result = (await governanceUnlock(makeCtx(repoRoot))) as any;

  assert.equal(result.ok, false);
  assert.equal(result.error, "PRECONDITIONS_NOT_MET");
  assert.ok(result.failedChecks.includes("kintsugi_integrity"));
  const after = readGovernanceLock(repoRoot);
  assert.equal(after.locked, true);
  assert.equal(after.reason, lockedWith.reason, "the original lock reason is kept");
});

test("unlock refuses while Ghost still reports a critical dual-witness deviation", async () => {
  const repoRoot = makeRepoRoot();
  dropCriticalProtectedPath(repoRoot);
  await governanceSelfTest(makeCtx(repoRoot));
  assert.equal(readGovernanceLock(repoRoot).locked, true);

  const result = (await governanceUnlock(makeCtx(repoRoot))) as any;

  assert.equal(result.ok, false);
  assert.equal(result.error, "PRECONDITIONS_NOT_MET");
  assert.deepEqual(result.failedChecks, ["ghost_critical"]);
  assert.equal(readGovernanceLock(repoRoot).locked, true);
});

test("a refused unlock is written to the audit ledger with the checks that failed", async () => {
  const repoRoot = makeRepoRoot();
  dropCriticalProtectedPath(repoRoot);
  await governanceSelfTest(makeCtx(repoRoot));

  const events: LedgerEvent[] = [];
  await governanceUnlock(makeCtx(repoRoot, events));

  const refused = events.find((e) => e.event === "governance.unlock.refused");
  assert.ok(refused, "governance.unlock.refused must be recorded");
  assert.equal(refused.data.reason, "PRECONDITIONS_NOT_MET");
  assert.deepEqual(refused.data.failedChecks, ["ghost_critical"]);
  assert.ok(!events.some((e) => e.event === "governance.unlock"), "no unlock event on a refusal");
});

test("once the cause is fixed, unlock clears the lock and records the fresh passing self-test", async () => {
  const repoRoot = makeRepoRoot();
  dropCriticalProtectedPath(repoRoot);
  await governanceSelfTest(makeCtx(repoRoot));
  assert.equal(readGovernanceLock(repoRoot).lastSelfTest?.ok, false);

  restoreDefaultConfig(repoRoot); // the cause: Ghost's critical path is back in Mnema's list
  const result = (await governanceUnlock(makeCtx(repoRoot))) as any;

  assert.equal(result.ok, true);
  const after = readGovernanceLock(repoRoot);
  assert.equal(after.locked, false);
  assert.equal(after.lastSelfTest?.ok, true, "the lock records the passing re-check, not the old failing one");
});

// Found while reading the self-test for step 2: the lock reason was chosen on
// `refused`, which is set when the guard CORRECTLY blocked the tripwire write.
// So a working guard plus a critical Ghost deviation produced the reason "A
// write to a protected audit path was not blocked", pointing the human at the
// wrong failure.
test("a critical Ghost deviation with a working guard locks with the Ghost reason, not 'write was not blocked'", async () => {
  const repoRoot = makeRepoRoot();
  dropCriticalProtectedPath(repoRoot);
  const result = (await governanceSelfTest(makeCtx(repoRoot))) as any;

  assert.equal(result.refusal.refusalReason, "LEDGER_PROTECTION", "the guard did block the tripwire write");
  assert.equal(result.lock.locked, true);
  assert.match(result.lock.reason, /Ghost verification/);
  assert.doesNotMatch(result.lock.reason, /was not blocked/);
});
