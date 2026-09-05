import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Ledger } from "../core/ledger";

// First test coverage for ledger.ts — the hash-chained audit record every
// capability writes observations through.

function makeRepoRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mk2-ledger-test-"));
}

function readEntries(repoRoot: string) {
  const p = path.join(repoRoot, "logs", "ledger.ndjson");
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

test("append writes an entry to disk and chains prevHash correctly", () => {
  const repoRoot = makeRepoRoot();
  const ledger = new Ledger(repoRoot);

  const first = ledger.append("s1", "event.one", { a: 1 });
  const second = ledger.append("s1", "event.two", { a: 2 });

  assert.equal(first.prevHash, undefined);
  assert.equal(second.prevHash, first.hash);

  const onDisk = readEntries(repoRoot);
  assert.equal(onDisk.length, 2);
  assert.equal(onDisk[1].prevHash, onDisk[0].hash);
});

test("a fresh Ledger instance continues the chain from what's already on disk", () => {
  const repoRoot = makeRepoRoot();
  const first = new Ledger(repoRoot).append("s1", "event.one");

  const second = new Ledger(repoRoot); // simulates a new process/request picking up an existing ledger
  const entry = second.append("s1", "event.two");
  assert.equal(entry.prevHash, first.hash);
});

test("writeEnabled: false computes a plausible entry but never touches disk", () => {
  const repoRoot = makeRepoRoot();
  const ledger = new Ledger(repoRoot, { writeEnabled: false });
  ledger.append("s1", "event.one", { a: 1 });

  assert.equal(fs.existsSync(path.join(repoRoot, "logs", "ledger.ndjson")), false);
});

test(
  "append() marks persisted: false and warns when the lock can't be acquired, rather than silently dropping the entry",
  { timeout: 5000 },
  () => {
    const repoRoot = makeRepoRoot();
    const ledger = new Ledger(repoRoot);
    ledger.append("s1", "event.one"); // real, on-disk entry, establishes logs/ dir + lock path

    const lockPath = path.join(repoRoot, "logs", "ledger.ndjson.lock");
    // Simulate a concurrent writer holding the lock for the whole 2s deadline
    // append() waits before giving up.
    fs.writeFileSync(lockPath, "");

    const originalWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (msg: string) => warnings.push(msg);

    const before = readEntries(repoRoot).length;
    const result = ledger.append("s1", "event.two-under-contention", { note: "must not be silently lost" });
    const after = readEntries(repoRoot).length;

    console.warn = originalWarn;
    fs.unlinkSync(lockPath);

    // It genuinely isn't written to disk — that part of the underlying
    // constraint (never fork the hash chain by writing without the lock)
    // is correct and unchanged.
    assert.equal(after, before, "the entry is still correctly not written to the ledger file");
    // But unlike before the fix, this is no longer indistinguishable from a
    // real append: the field is explicit, and it's also logged.
    assert.equal(result.persisted, false);
    assert.equal(result.event, "event.two-under-contention");
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /could not acquire lock/);
  }
);

test("a normal, successful append has no persisted field at all — existing callers see no shape change", () => {
  const repoRoot = makeRepoRoot();
  const entry = new Ledger(repoRoot).append("s1", "event.one");
  assert.equal("persisted" in entry, false);
});
