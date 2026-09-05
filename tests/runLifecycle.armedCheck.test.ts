import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";
import { runLifecycle } from "../core/runLifecycle";
import { createRouter } from "../core/router";
import { createPolicy } from "../core/policy";

// Found while reading runLifecycle.ts, then verified with this test before
// fixing: the "is this plan armed" check that decides preview-vs-apply
// unconditionally looks at plan.steps[0]'s approval — even when a *different*
// step is the one actually being targeted via executeStepId. searchDocApply
// produces a real, currently-shipping 2-step plan (step-1: preview,
// read-only, no approval needed; step-2: apply, CONTROLLED_WRITE) — exactly
// the shape where this matters: targeting step-2 with a fully valid, armed
// approval, with no approval at all for step-1, should execute step-2. It
// didn't — it silently fell back to preview-only, with no refusal code
// explaining why, because it checked the wrong step's approval.

function makeRepoRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mk2-runlifecycle-test-"));
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "test" }));
  fs.mkdirSync(path.join(dir, "config"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "config", "allowlist.json"),
    JSON.stringify({ allowedCapabilities: ["searchDocPreview", "searchDocApply"] })
  );
  fs.writeFileSync(
    path.join(dir, "config", "auernyx.config.json"),
    JSON.stringify({ governance: { approverIdentity: "Test Approver" }, writeEnabled: true })
  );
  // runLifecycle's own APPLY preconditions (independent of the router/policy
  // gates) require a real, clean git repo and a .gitignore covering the
  // canon paths — real-world preconditions, not test artifacts to work
  // around.
  // Matches this repo's own .gitignore: .auernyx/ and logs/ are runLifecycle's
  // own bookkeeping (genesis, receipts, ledger) — without ignoring them, the
  // act of running runLifecycle at all makes its own git tree look dirty by
  // the time the mid-run preflight dirty-check runs, which isn't the
  // scenario this test is actually about.
  fs.writeFileSync(path.join(dir, ".gitignore"), ".canon/\nvar/canon/\n.auernyx/\nlogs/\n");
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", "initial"], { cwd: dir });
  return dir;
}

const approval = {
  approvedBy: "human" as const,
  at: new Date().toISOString(),
  reason: "test",
  identity: "Test Approver",
};

test("targeting step-2 of a real 2-step plan with a valid, armed approval for step-2 actually executes it", async () => {
  const repoRoot = makeRepoRoot();
  const applyCalled = { value: false };
  const router = createRouter(
    createPolicy(repoRoot),
    {
      searchDocPreview: async () => ({ mode: "preview" }),
      searchDocApply: async () => {
        applyCalled.value = true;
        return { mode: "applied" };
      },
    } as any
  );

  const result = (await runLifecycle({
    router,
    ctx: { repoRoot, sessionId: "test-session" } as any,
    intent: "search doc apply",
    input: { action: "add", docPath: "docs/x.md", title: "X" },
    executeStepId: "step-2",
    stepApprovals: [
      { ...approval, stepId: "step-2", apply: true, confirm: "APPLY", acknowledgedRollbackPointIds: ["rb-1"] },
    ],
  })) as any;

  assert.equal(applyCalled.value, true, "step-2's capability function should actually have run");
  assert.equal(result.ok, true);
  // A separate, related bug found and fixed the same day: every return path
  // in runLifecycle.ts reported plan.steps[0]'s tool name as "capability",
  // regardless of which step actually executed. Verified directly before
  // fixing: this exact scenario (step-2 targeted and successfully executed)
  // reported capability: "searchDocPreview" (step-1's tool), never
  // "searchDocApply" — the write operation that actually ran.
  assert.equal(result.capability, "searchDocApply");
});

test("a missing approval for a later step (not step-0) reports THAT step as the capability, not step-0's", async () => {
  const repoRoot = makeRepoRoot();
  const router = createRouter(
    createPolicy(repoRoot),
    {
      searchDocPreview: async () => ({ mode: "preview" }),
      searchDocApply: async () => ({ mode: "applied" }),
    } as any
  );

  const result = (await runLifecycle({
    router,
    ctx: { repoRoot, sessionId: "test-session" } as any,
    intent: "search doc apply",
    input: { action: "add", docPath: "docs/x.md", title: "X" },
    // Full-plan run: step-1 has a valid, armed approval so execution enters
    // the loop at all; step-2 (searchDocApply) has none, so the loop's own
    // "approval missing" refusal fires specifically for step-2.
    stepApprovals: [{ ...approval, stepId: "step-1", apply: true, confirm: "APPLY" }],
  })) as any;

  assert.equal(result.ok, false);
  assert.equal(result.refusal.code, "REFUSE_WRITE_GATE_MISSING");
  assert.equal(result.missingStepIds[0], "step-2");
  assert.equal(result.capability, "searchDocApply");
});

test("without a matching step-2 approval, the same plan still correctly falls back to preview-only", async () => {
  const repoRoot = makeRepoRoot();
  const applyCalled = { value: false };
  const router = createRouter(
    createPolicy(repoRoot),
    {
      searchDocPreview: async () => ({ mode: "preview" }),
      searchDocApply: async () => {
        applyCalled.value = true;
        return { mode: "applied" };
      },
    } as any
  );

  const result = (await runLifecycle({
    router,
    ctx: { repoRoot, sessionId: "test-session" } as any,
    intent: "search doc apply",
    input: { action: "add", docPath: "docs/x.md", title: "X" },
    // No executeStepId, no stepApprovals at all — the ordinary "just plan
    // and preview" path must remain preview-only, not accidentally armed.
  })) as any;

  assert.equal(applyCalled.value, false);
  assert.equal(result.ok, true);
  assert.deepEqual(result.result, []);
});
