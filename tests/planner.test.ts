import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { createRouter } from "../core/router";
import { createPolicy } from "../core/policy";
import { sha256Hex, stableStringify } from "../core/crypto";
import { planForIntent, Planner } from "../core/planner";

// First test coverage for core/planner.ts. No new bugs found — read closely
// looking for the pattern that's repeatedly turned up real bugs elsewhere
// this session (a safeguard that fails under the exact condition it exists
// for) and didn't find one here. Two things worth recording as deliberately
// NOT bugs, checked directly rather than assumed:
//   - cloneNoSharedRefs (and core/crypto.ts's stableStringify, used
//     throughout the entire ledger/receipt/kintsugi hashing stack) both clone
//     a Date/RegExp/Map/Set via generic Object.keys() iteration, which would
//     silently collapse one to {}. Not flagged as a planner-specific bug:
//     it's the same pre-existing, already-relied-upon shape as
//     stableStringify itself, and every capability input in this codebase is
//     plain JSON-shaped (object/array/string/number/boolean/null) by
//     contract — never an actual Date/RegExp/Map/Set instance.
//   - planId embeds the raw `intent` string, so two calls with differently
//     phrased text that route to the same capability get different planIds.
//     Checked whether that could break the searchDocPreview/searchDocApply
//     two-step approval flow (a step-2 approval created against one planId
//     failing to match a freshly re-derived plan under a second, differently
//     worded call) — it can't: approvals (core/approvals.ts) carry no planId
//     field at all, and runLifecycle.ts calls planForIntent exactly once per
//     invocation using that invocation's own intent. planId is audit/receipt
//     metadata, not a security-relevant matching key.

function makeRepoRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mk2-planner-test-"));
}

// planForIntent only ever calls router.route() — never executeStep/run — so
// a real router with an empty capabilities map is sufficient and exercises
// the actual production routing rules in core/router.ts, not a hand-rolled
// stand-in that could quietly drift from them.
function makeRouter(repoRoot: string) {
  return createRouter(createPolicy(repoRoot), {} as any);
}

// ─── Unroutable intent ──────────────────────────────────────────────────────

test("throws unroutable_intent for text the router cannot match to any capability", () => {
  const router = makeRouter(makeRepoRoot());
  assert.throws(() => planForIntent(router, "gibberish nobody would ever say"), /unroutable_intent/);
});

// ─── Single-step classification ────────────────────────────────────────────

test("a read-only tier-0 capability produces a single READ_ONLY step with no rollback points, LOW risk", () => {
  const router = makeRouter(makeRepoRoot());
  const plan = planForIntent(router, "scan the repository please", { targetDir: "." });

  assert.equal(plan.steps.length, 1);
  assert.equal(plan.steps[0].type, "READ_ONLY");
  assert.equal(plan.steps[0].tool.name, "scanRepo");
  assert.deepEqual(plan.steps[0].input, { targetDir: "." });
  assert.deepEqual(plan.steps[0].requiredEvidence, []);
  assert.equal(plan.steps[0].rollbackPointId, undefined);
  assert.deepEqual(plan.rollbackPoints, []);
  assert.equal(plan.riskClass, "LOW");
  assert.deepEqual(plan.tools, [{ kind: "capability", name: "scanRepo" }]);
  assert.equal(plan.version, 2);
});

test("a non-readonly tier-1 capability produces a single CONTROLLED_WRITE step with one generic rollback point, MEDIUM risk", () => {
  const router = makeRouter(makeRepoRoot());
  const plan = planForIntent(router, "run a governance self test");

  assert.equal(plan.steps.length, 1);
  assert.equal(plan.steps[0].type, "CONTROLLED_WRITE");
  assert.equal(plan.steps[0].tool.name, "governanceSelfTest");
  assert.equal(plan.rollbackPoints.length, 1);
  assert.equal(plan.rollbackPoints[0].id, "rb-1");
  assert.equal(plan.steps[0].rollbackPointId, "rb-1");
  assert.equal(plan.riskClass, "MEDIUM");
});

test("a non-readonly tier-2 capability produces a single HIGH_RISK step, HIGH risk", () => {
  const router = makeRouter(makeRepoRoot());
  const plan = planForIntent(router, "rollback to the last known good state");

  assert.equal(plan.steps.length, 1);
  assert.equal(plan.steps[0].type, "HIGH_RISK");
  assert.equal(plan.steps[0].tool.name, "rollbackKnownGood");
  assert.equal(plan.rollbackPoints.length, 1);
  assert.equal(plan.riskClass, "HIGH");
});

test("no input given: the step's own input stays undefined, but inputHash is computed against null", () => {
  const router = makeRouter(makeRepoRoot());
  const plan = planForIntent(router, "scan the repository please");

  assert.equal(plan.steps[0].input, undefined);
  assert.equal(plan.inputHash, sha256Hex(stableStringify(null)));
});

// ─── The searchDoc special case ─────────────────────────────────────────────

test("searchDocPreview and searchDocApply both route to the identical governed 2-step plan shape", () => {
  const router = makeRouter(makeRepoRoot());
  const previewPlan = planForIntent(router, "search doc preview quantum encryption", { query: "quantum encryption" });
  const applyPlan = planForIntent(router, "search doc apply quantum encryption", { query: "quantum encryption" });

  for (const plan of [previewPlan, applyPlan]) {
    assert.equal(plan.steps.length, 2);
    assert.equal(plan.steps[0].id, "step-1");
    assert.equal(plan.steps[0].type, "READ_ONLY");
    assert.equal(plan.steps[0].tool.name, "searchDocPreview");
    assert.deepEqual(plan.steps[0].requiredEvidence, []);
    assert.equal(plan.steps[0].rollbackPointId, undefined);

    assert.equal(plan.steps[1].id, "step-2");
    assert.equal(plan.steps[1].type, "CONTROLLED_WRITE");
    assert.equal(plan.steps[1].tool.name, "searchDocApply");
    assert.equal(plan.steps[1].requiredEvidence.length, 1);
    assert.equal(plan.steps[1].rollbackPointId, "rb-1");

    assert.deepEqual(plan.tools, [
      { kind: "capability", name: "searchDocPreview" },
      { kind: "capability", name: "searchDocApply" },
    ]);
    assert.equal(plan.rollbackPoints.length, 1);
    assert.equal(plan.riskClass, "MEDIUM");
    assert.equal(plan.requiredEvidence.length, 1);
  }

  // Both raw intents produced the exact same step/tool/risk shape even
  // though the router itself classified them as two different capabilities.
  assert.deepEqual(previewPlan.steps, applyPlan.steps);
});

test("step-1 and step-2 inputs in the searchDoc plan are independently cloned — mutating one never affects the other", () => {
  const router = makeRouter(makeRepoRoot());
  const input = { nested: { foo: 1 } };
  const plan = planForIntent(router, "search doc apply x", input);

  assert.notEqual(plan.steps[0].input, plan.steps[1].input);
  (plan.steps[0].input as any).nested.foo = 999;
  assert.equal((plan.steps[1].input as any).nested.foo, 1);
  // And neither is the same object as the caller's original input.
  assert.equal(input.nested.foo, 1);
});

test("requiredEvidence on the searchDoc plan and on step-2 are independent clones with the same content", () => {
  const router = makeRouter(makeRepoRoot());
  const plan = planForIntent(router, "search doc apply x");

  assert.deepEqual(plan.requiredEvidence, plan.steps[1].requiredEvidence);
  assert.notEqual(plan.requiredEvidence, plan.steps[1].requiredEvidence);
});

// ─── planId determinism ─────────────────────────────────────────────────────

test("planId is deterministic across repeated calls with identical intent and input", () => {
  const router = makeRouter(makeRepoRoot());
  const a = planForIntent(router, "scan the repository please", { x: 1 });
  const b = planForIntent(router, "scan the repository please", { x: 1 });
  assert.equal(a.planId, b.planId);
});

test("planId does not depend on the input object's key insertion order", () => {
  const router = makeRouter(makeRepoRoot());
  const a = planForIntent(router, "scan the repository please", { a: 1, b: 2 });
  const b = planForIntent(router, "scan the repository please", { b: 2, a: 1 });
  assert.equal(a.planId, b.planId);
});

test("planId changes when input changes", () => {
  const router = makeRouter(makeRepoRoot());
  const a = planForIntent(router, "scan the repository please", { x: 1 });
  const b = planForIntent(router, "scan the repository please", { x: 2 });
  assert.notEqual(a.planId, b.planId);
});

test("planId changes when the raw intent text changes, even if it routes to the same capability", () => {
  const router = makeRouter(makeRepoRoot());
  const a = planForIntent(router, "scan the repository please");
  const b = planForIntent(router, "scan repo now");
  assert.equal(a.steps[0].tool.name, "scanRepo");
  assert.equal(b.steps[0].tool.name, "scanRepo");
  assert.notEqual(a.planId, b.planId);
});

// ─── Planner class wrapper ──────────────────────────────────────────────────

test("Planner.createPlan delegates to planForIntent and produces the same deterministic result", () => {
  const router = makeRouter(makeRepoRoot());
  const planner = new Planner(router);
  const viaClass = planner.createPlan("scan the repository please", { x: 1 });
  const viaFunction = planForIntent(router, "scan the repository please", { x: 1 });
  assert.deepEqual(viaClass, viaFunction);
});
