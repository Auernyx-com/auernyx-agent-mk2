import assert from "node:assert/strict";
import test from "node:test";
import { stableStringify, sha256Hex } from "../core/crypto";

// First direct unit coverage for crypto.ts. Every hash-producing code path
// in this codebase depends on stableStringify actually being stable —
// worth pinning directly rather than only ever exercising it indirectly.

test("stableStringify produces identical output regardless of key insertion order", () => {
  const a = { z: 1, a: 2, m: { y: 1, b: 2 } };
  const b = { a: 2, z: 1, m: { b: 2, y: 1 } };
  assert.equal(stableStringify(a), stableStringify(b));
});

test("stableStringify omits undefined-valued keys entirely, rather than emitting null", () => {
  const result = stableStringify({ a: 1, b: undefined });
  assert.equal(result, '{"a":1}');
});

test("stableStringify preserves array order (arrays are ordered data, not sorted like object keys)", () => {
  assert.notEqual(stableStringify([1, 2, 3]), stableStringify([3, 2, 1]));
});

test("stableStringify throws on a circular reference rather than hanging or silently truncating", () => {
  const obj: any = { a: 1 };
  obj.self = obj;
  assert.throws(() => stableStringify(obj), /circular_json/);
});

test("sha256Hex is deterministic and sensitive to any input change", () => {
  const h1 = sha256Hex("hello");
  const h2 = sha256Hex("hello");
  const h3 = sha256Hex("hello!");
  assert.equal(h1, h2);
  assert.notEqual(h1, h3);
  assert.equal(h1.length, 64);
});
