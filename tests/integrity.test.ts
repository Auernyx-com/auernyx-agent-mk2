import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { verifyLedgerIntegrity } from "../core/integrity";
import { Ledger } from "../core/ledger";

// First direct unit coverage for integrity.ts — verifyLedgerIntegrity is
// what governanceUnlock relies on as its own real safety gate (see
// router.governanceUnlock.test.ts), and previously had no tests of its own
// failure modes in isolation.

function makeRepoRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mk2-integrity-test-"));
}

test("a missing ledger file is treated as a trivially valid empty chain", () => {
  const result = verifyLedgerIntegrity(makeRepoRoot());
  assert.equal(result.ok, true);
  assert.equal(result.checkedEntries, 0);
});

test("a real ledger produced by Ledger.append verifies clean", () => {
  const repoRoot = makeRepoRoot();
  const ledger = new Ledger(repoRoot);
  ledger.append("s1", "event.one");
  ledger.append("s1", "event.two");
  ledger.append("s1", "event.three");

  const result = verifyLedgerIntegrity(repoRoot);
  assert.equal(result.ok, true);
  assert.equal(result.checkedEntries, 3);
});

function ledgerPath(repoRoot: string): string {
  const dir = path.join(repoRoot, "logs");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, "ledger.ndjson");
}

test("a non-JSON line in the ledger fails closed", () => {
  const repoRoot = makeRepoRoot();
  fs.writeFileSync(ledgerPath(repoRoot), "not json at all\n");
  const result = verifyLedgerIntegrity(repoRoot);
  assert.equal(result.ok, false);
  assert.match(result.warnings[0], /non-JSON/);
});

test("an entry missing its hash field fails closed", () => {
  const repoRoot = makeRepoRoot();
  fs.writeFileSync(ledgerPath(repoRoot), JSON.stringify({ ts: "x", sessionId: "s", event: "e" }) + "\n");
  const result = verifyLedgerIntegrity(repoRoot);
  assert.equal(result.ok, false);
  assert.match(result.warnings[0], /missing hash/);
});

test("a broken prevHash chain link is detected", () => {
  const repoRoot = makeRepoRoot();
  const ledger = new Ledger(repoRoot);
  ledger.append("s1", "event.one");
  ledger.append("s1", "event.two");

  // Tamper: rewrite the second entry's prevHash to something that doesn't
  // match the first entry's actual hash.
  const p = ledgerPath(repoRoot);
  const lines = fs.readFileSync(p, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  lines[1].prevHash = "0".repeat(64);
  fs.writeFileSync(p, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");

  const result = verifyLedgerIntegrity(repoRoot);
  assert.equal(result.ok, false);
  assert.match(result.warnings[0], /prevHash mismatch/);
});

test("a tampered entry (content changed, hash left stale) is detected", () => {
  const repoRoot = makeRepoRoot();
  const ledger = new Ledger(repoRoot);
  ledger.append("s1", "event.one", { amount: 100 });

  const p = ledgerPath(repoRoot);
  const lines = fs.readFileSync(p, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  lines[0].data.amount = 999999; // tampered, hash left as originally computed
  fs.writeFileSync(p, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");

  const result = verifyLedgerIntegrity(repoRoot);
  assert.equal(result.ok, false);
  assert.match(result.warnings[0], /hash mismatch/);
});

test("maxEntries limits how much of a long ledger gets checked, from the tail", () => {
  const repoRoot = makeRepoRoot();
  const ledger = new Ledger(repoRoot);
  for (let i = 0; i < 10; i++) ledger.append("s1", `event.${i}`);

  const result = verifyLedgerIntegrity(repoRoot, { maxEntries: 3 });
  assert.equal(result.ok, true);
  assert.equal(result.checkedEntries, 3);
  // Independent-audit finding (2026-09-08, round 10, medium): a windowed
  // check like this one never verifies linkage to genesis -- see the
  // "tampered prefix" test below for what that means in practice. `ok:true`
  // here must not be read as an end-to-end integrity guarantee; `truncated`
  // is what actually distinguishes the two, and callers gating a real
  // security decision on this result (governanceUnlock) must check it.
  assert.equal(result.truncated, true);
});

test("a check that covers the WHOLE ledger is not marked truncated", () => {
  const repoRoot = makeRepoRoot();
  const ledger = new Ledger(repoRoot);
  for (let i = 0; i < 10; i++) ledger.append("s1", `event.${i}`);

  const result = verifyLedgerIntegrity(repoRoot, { maxEntries: 10 });
  assert.equal(result.ok, true);
  assert.equal(result.checkedEntries, 10);
  assert.equal(result.truncated, false);
});

test("a fabricated/tampered prefix entirely outside the checked window is NOT caught", () => {
  // Independent-audit finding (2026-09-08, round 10, medium): confirmed
  // directly before this fix -- a ledger whose prefix (outside maxEntries)
  // contains a literally-invalid JSON line and a fabricated hash still
  // reported ok:true with zero indication that prefix was never read. The
  // `truncated` flag exists precisely because THIS case cannot be told
  // apart from a genuinely clean, fully-verified ledger by `ok` alone.
  const repoRoot = makeRepoRoot();
  fs.mkdirSync(path.join(repoRoot, "logs"), { recursive: true });
  const p = path.join(repoRoot, "logs", "ledger.ndjson");

  const bogusPrefix = [
    "{this is not even valid json",
    JSON.stringify({ ts: "x", sessionId: "x", event: "TAMPERED", data: {}, prevHash: "anything", hash: "deadbeef" }),
  ];

  const ledger = new Ledger(repoRoot);
  ledger.append("s1", "real.event.one");
  ledger.append("s1", "real.event.two");
  ledger.append("s1", "real.event.three");
  const realLines = fs.readFileSync(p, "utf8").trim().split("\n");

  fs.writeFileSync(p, [...bogusPrefix, ...realLines].join("\n") + "\n");

  const result = verifyLedgerIntegrity(repoRoot, { maxEntries: 3 });
  assert.equal(result.ok, true, "the windowed check itself still reports ok -- that's the point of this test");
  assert.equal(result.truncated, true, "but it MUST be flagged as truncated so a caller can refuse to trust it");
});
