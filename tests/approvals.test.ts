import assert from "node:assert/strict";
import test from "node:test";
import { isValidApproval, isValidStepApproval, approvalIdentity, createHumanApproval } from "../core/approvals";

// First direct unit coverage for approvals.ts — previously only exercised
// indirectly through router.*.test.ts. These are the structural checks that
// sit directly in front of every tier-1/2 capability execution.

test("isValidApproval rejects non-objects and null", () => {
  assert.equal(isValidApproval(undefined), false);
  assert.equal(isValidApproval(null), false);
  assert.equal(isValidApproval("human"), false);
  assert.equal(isValidApproval(42), false);
});

test("isValidApproval requires approvedBy === 'human', a string 'at', and a non-blank reason", () => {
  assert.equal(isValidApproval({ approvedBy: "robot", at: "2026-01-01", reason: "x" }), false);
  assert.equal(isValidApproval({ approvedBy: "human", at: "2026-01-01", reason: "" }), false);
  assert.equal(isValidApproval({ approvedBy: "human", at: "2026-01-01", reason: "   " }), false);
  assert.equal(isValidApproval({ approvedBy: "human", reason: "x" }), false); // missing at
  assert.equal(isValidApproval({ approvedBy: "human", at: "2026-01-01", reason: "fine" }), true);
});

test("isValidStepApproval additionally requires a non-blank stepId", () => {
  const base = { approvedBy: "human" as const, at: "2026-01-01", reason: "fine" };
  assert.equal(isValidStepApproval(base), false);
  assert.equal(isValidStepApproval({ ...base, stepId: "" }), false);
  assert.equal(isValidStepApproval({ ...base, stepId: "s1" }), true);
});

test("isValidStepApproval validates optional evidenceRefs and acknowledgedRollbackPointIds when present", () => {
  const base = { approvedBy: "human" as const, at: "2026-01-01", reason: "fine", stepId: "s1" };
  assert.equal(isValidStepApproval({ ...base, evidenceRefs: ["ref1", "ref2"] }), true);
  assert.equal(isValidStepApproval({ ...base, evidenceRefs: ["", "ref2"] }), false, "a blank ref is invalid");
  assert.equal(isValidStepApproval({ ...base, evidenceRefs: "not-an-array" }), false);
  assert.equal(isValidStepApproval({ ...base, acknowledgedRollbackPointIds: ["kgs1"] }), true);
  assert.equal(isValidStepApproval({ ...base, acknowledgedRollbackPointIds: [123] }), false);
});

test("approvalIdentity returns the trimmed identity when present and non-blank, undefined otherwise", () => {
  assert.equal(approvalIdentity(createHumanApproval("x", { identity: "  Justin Hughes  " })), "Justin Hughes");
  assert.equal(approvalIdentity(createHumanApproval("x", { identity: "" })), undefined);
  assert.equal(approvalIdentity(createHumanApproval("x")), undefined);
  assert.equal(approvalIdentity(undefined), undefined);
});

test("createHumanApproval produces a structurally valid approval by construction", () => {
  const approval = createHumanApproval("because reasons", { apply: true, confirm: "APPLY" });
  assert.equal(isValidApproval(approval), true);
  assert.equal(approval.approvedBy, "human");
  assert.equal(approval.apply, true);
  assert.equal(approval.confirm, "APPLY");
});
