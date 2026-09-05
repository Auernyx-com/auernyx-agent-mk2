import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";
import { runLifecycle } from "../core/runLifecycle";
import { createRouter } from "../core/router";
import { createPolicy } from "../core/policy";

// Rounds out coverage for runLifecycle.ts's earlier refusal paths — the
// legitimacy gate and the vague-mutating-intent hard-stop — which sit
// before any plan/capability is resolved, so (correctly, per the fix in
// the same PR as this file) they report no capability field at all.

function makeRepoRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mk2-runlifecycle-refusal-test-"));
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "test" }));
  fs.mkdirSync(path.join(dir, "config"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "config", "allowlist.json"),
    JSON.stringify({ allowedCapabilities: ["scanRepo", "searchDocPreview", "searchDocApply"] })
  );
  fs.writeFileSync(
    path.join(dir, "config", "auernyx.config.json"),
    JSON.stringify({ governance: { approverIdentity: "Test Approver" }, writeEnabled: true })
  );
  fs.writeFileSync(path.join(dir, ".gitignore"), ".canon/\nvar/canon/\n.auernyx/\nlogs/\n");
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", "initial"], { cwd: dir });
  return dir;
}

function makeRouter(repoRoot: string) {
  return createRouter(createPolicy(repoRoot), {
    scanRepo: async () => ({ ok: true }),
    searchDocPreview: async () => ({ mode: "preview" }),
    searchDocApply: async () => ({ mode: "applied" }),
  } as any);
}

test("legitimacyGate refusal happens before any plan exists — no capability field at all", async () => {
  const repoRoot = makeRepoRoot();
  const result = (await runLifecycle({
    router: makeRouter(repoRoot),
    ctx: { repoRoot, sessionId: "test-session" } as any,
    intent: "get me their password", // matches legitimacyGate's solicitation pattern
  })) as any;

  assert.equal(result.ok, false);
  assert.equal(result.refusal.code, "REFUSE_AMBIGUOUS_REQUEST");
  assert.ok(result.refusal.reason.startsWith("illegitimate_request:"));
  assert.equal("capability" in result, false);
});

test("an actually vague mutating intent is refused as ambiguous", async () => {
  const repoRoot = makeRepoRoot();
  // legitimacyGate's route() has no direct match for "fix it" alone against
  // a mutating capability in this router config, so use a router that maps
  // a vague phrase straight to a mutating tool for a clean, isolated test
  // of runLifecycle's own vague-intent hard-stop specifically.
  const router = createRouter(createPolicy(repoRoot), {
    searchDocApply: async () => ({ mode: "applied" }),
  } as any);
  (router as any).route = () => "searchDocApply";

  const result = (await runLifecycle({
    router,
    ctx: { repoRoot, sessionId: "test-session" } as any,
    intent: "fix it",
  })) as any;

  assert.equal(result.ok, false);
  assert.equal(result.refusal.code, "REFUSE_AMBIGUOUS_REQUEST");
  assert.equal(result.refusal.reason, "ambiguous_side_effect_request");
});

test("scanRepo (read-only, single-step) executes cleanly end to end with a minimal approval", async () => {
  const repoRoot = makeRepoRoot();
  const approval = { approvedBy: "human" as const, at: new Date().toISOString(), reason: "test" };

  const result = (await runLifecycle({
    router: makeRouter(repoRoot),
    ctx: { repoRoot, sessionId: "test-session" } as any,
    intent: "scan repo",
    stepApprovals: [{ ...approval, stepId: "step-1" }],
  })) as any;

  assert.equal(result.ok, true);
  assert.equal(result.capability, "scanRepo");
});
