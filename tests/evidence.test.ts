import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";
import {
  evidenceFromPastedText,
  evidenceFromExternalRef,
  evidenceFromFileHash,
  sha256FileHex,
} from "../core/evidence";

function sha256(buf: Buffer | string): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

test("evidenceFromPastedText hashes the exact text and derives a stable id from it", () => {
  const ev = evidenceFromPastedText("hello world");
  assert.equal(ev.type, "pasted_text");
  assert.equal(ev.hash, sha256("hello world"));
  assert.equal(ev.id, `ev-${ev.hash.slice(0, 16)}`);
});

test("evidenceFromPastedText treats blank/whitespace-only notes as absent", () => {
  assert.equal(evidenceFromPastedText("x", "  ").notes, undefined);
  assert.equal(evidenceFromPastedText("x", "").notes, undefined);
  assert.equal(evidenceFromPastedText("x", "real note").notes, "real note");
});

test("evidenceFromExternalRef normalizes (trims) the ref before hashing", () => {
  const ev = evidenceFromExternalRef("  https://example.com/thing  ");
  assert.equal(ev.source, "https://example.com/thing");
  assert.equal(ev.hash, sha256("https://example.com/thing"));
});

test("sha256FileHex matches a direct hash of the same file content", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mk2-evidence-test-"));
  const filePath = path.join(dir, "data.bin");
  const content = Buffer.from("some file content to hash, repeated ".repeat(1000), "utf8");
  fs.writeFileSync(filePath, content);

  assert.equal(sha256FileHex(filePath), sha256(content));
});

test("evidenceFromFileHash produces the same hash/id as hashing the file directly", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mk2-evidence-test-"));
  const filePath = path.join(dir, "data.txt");
  fs.writeFileSync(filePath, "content");

  const ev = evidenceFromFileHash(filePath);
  assert.equal(ev.type, "file_hash");
  assert.equal(ev.hash, sha256FileHex(filePath));
  assert.equal(ev.source, filePath);
});

test("evidenceFromFileHash throws for a file that doesn't exist, rather than fabricating evidence", () => {
  assert.throws(() => evidenceFromFileHash("/definitely/does/not/exist.txt"));
});

test("two different evidence sources produce two different ids", () => {
  const a = evidenceFromPastedText("content A");
  const b = evidenceFromPastedText("content B");
  assert.notEqual(a.id, b.id);
});
