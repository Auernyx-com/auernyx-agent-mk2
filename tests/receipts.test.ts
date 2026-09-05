import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";
import { createReceiptWriter } from "../core/receipts";

// First test coverage for receipts.ts — "every run, success or refusal,
// produces a receipt" is Non-Negotiable Invariant #3 in
// AUERNYX_AGENT_MK2_SUMMARY.md, and the writer itself had zero direct tests.

function makeRepoRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mk2-receipts-test-"));
}

function sha256(buf: Buffer | string): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

test("receiptsEnabled: false returns null — the caller's own responsibility to handle", () => {
  const writer = createReceiptWriter(makeRepoRoot(), { receiptsEnabled: false });
  assert.equal(writer, null);
});

test("writeJson writes the value and a matching sidecar hash", () => {
  const repoRoot = makeRepoRoot();
  const writer = createReceiptWriter(repoRoot, { receiptsEnabled: true })!;
  writer.writeJson("intake.json", { hello: "world" });

  const filePath = path.join(writer.dirPath, "intake.json");
  const body = fs.readFileSync(filePath, "utf8");
  assert.deepEqual(JSON.parse(body), { hello: "world" });

  const hash = fs.readFileSync(filePath + ".sha256", "utf8").trim();
  assert.equal(hash, sha256(body));
});

test("writeText appends a trailing newline exactly once", () => {
  const repoRoot = makeRepoRoot();
  const writer = createReceiptWriter(repoRoot, { receiptsEnabled: true })!;

  writer.writeText("no-newline.txt", "hello");
  assert.equal(fs.readFileSync(path.join(writer.dirPath, "no-newline.txt"), "utf8"), "hello\n");

  writer.writeText("has-newline.txt", "hello\n");
  assert.equal(fs.readFileSync(path.join(writer.dirPath, "has-newline.txt"), "utf8"), "hello\n");
});

test("ensureEmptyFile creates an empty file with a correct hash, and never overwrites existing content", () => {
  const repoRoot = makeRepoRoot();
  const writer = createReceiptWriter(repoRoot, { receiptsEnabled: true })!;

  writer.ensureEmptyFile("approvals.ndjson");
  const filePath = path.join(writer.dirPath, "approvals.ndjson");
  assert.equal(fs.readFileSync(filePath, "utf8"), "");
  assert.equal(fs.readFileSync(filePath + ".sha256", "utf8").trim(), sha256(""));

  // A later real write to the same file must survive a repeated ensureEmptyFile call.
  fs.writeFileSync(filePath, "real content\n", "utf8");
  writer.ensureEmptyFile("approvals.ndjson");
  assert.equal(fs.readFileSync(filePath, "utf8"), "real content\n");
});

test("appendEvent accumulates newline-delimited JSON events in order", () => {
  const repoRoot = makeRepoRoot();
  const writer = createReceiptWriter(repoRoot, { receiptsEnabled: true })!;

  writer.appendEvent("provenance.ok");
  writer.appendEvent("refusal", { code: "REFUSE_AMBIGUOUS_REQUEST" });

  const lines = fs
    .readFileSync(path.join(writer.dirPath, "events.ndjson"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));

  assert.equal(lines.length, 2);
  assert.equal(lines[0].kind, "provenance.ok");
  assert.equal(lines[1].kind, "refusal");
  assert.deepEqual(lines[1].data, { code: "REFUSE_AMBIGUOUS_REQUEST" });
});

test("finalize seals events.ndjson and every appended ndjson file with a matching hash", () => {
  const repoRoot = makeRepoRoot();
  const writer = createReceiptWriter(repoRoot, { receiptsEnabled: true })!;

  writer.appendEvent("started");
  writer.appendNdjson("toolcalls.ndjson", { tool: "scanRepo" });
  writer.appendNdjson("toolcalls.ndjson", { tool: "memoryCheck" });

  const result = writer.finalize();
  assert.equal(result.runId, writer.runId);
  assert.equal(result.dirPath, writer.dirPath);

  const eventsPath = path.join(writer.dirPath, "events.ndjson");
  assert.equal(
    fs.readFileSync(eventsPath + ".sha256", "utf8").trim(),
    sha256(fs.readFileSync(eventsPath))
  );

  const toolcallsPath = path.join(writer.dirPath, "toolcalls.ndjson");
  assert.equal(
    fs.readFileSync(toolcallsPath + ".sha256", "utf8").trim(),
    sha256(fs.readFileSync(toolcallsPath))
  );
});

test("finalize is safe to call when nothing was ever written (a refusal before any event)", () => {
  const repoRoot = makeRepoRoot();
  const writer = createReceiptWriter(repoRoot, { receiptsEnabled: true })!;

  // No writeJson/appendEvent/appendNdjson calls at all — mirrors a refusal
  // that happens before the run gets far enough to record anything.
  assert.doesNotThrow(() => writer.finalize());
});

test("each run gets its own unique receipt directory", () => {
  const repoRoot = makeRepoRoot();
  const a = createReceiptWriter(repoRoot, { receiptsEnabled: true })!;
  const b = createReceiptWriter(repoRoot, { receiptsEnabled: true })!;
  assert.notEqual(a.runId, b.runId);
  assert.notEqual(a.dirPath, b.dirPath);
});
