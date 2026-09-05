import assert from "node:assert/strict";
import test from "node:test";
import { createState } from "../core/state";

// First test coverage for core/state.ts. No bugs found — a small factory
// function, works exactly as documented.

test("createState returns a fresh session id, a valid ISO startedAt, and empty memory", () => {
  const state = createState();
  assert.match(state.sessionId, /^\d+-[0-9a-f]+$/);
  assert.equal(new Date(state.startedAt).toISOString(), state.startedAt);
  assert.deepEqual(state.memory, {});
});

test("createState produces distinct session ids across many rapid calls, including within the same millisecond", () => {
  const ids = new Set<string>();
  for (let i = 0; i < 200; i++) {
    ids.add(createState().sessionId);
  }
  assert.equal(ids.size, 200);
});

test("each call returns its own independent memory object", () => {
  const a = createState();
  const b = createState();
  (a.memory as Record<string, unknown>).foo = "bar";
  assert.deepEqual(b.memory, {});
});
