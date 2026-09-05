import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { mondayOnboarding } from "../capabilities/mondayOnboarding";

// First test coverage for mondayOnboarding.ts. Found and fixed a real gap
// while writing these: buildRecommendedConfig checks answers["enable_skjoldr"]
// to decide whether to recommend the 6 skjoldrFirewall capabilities, but no
// question with that id existed anywhere in QUESTION_BANK — verified directly
// with a full phase1->phase2->phase3 run answering every real question `true`,
// and no skjoldrFirewall capability ever appeared in recommended_allowlist.
// Onboarding could never recommend the Skjoldr addon for any deployment.
// Fixed by adding the missing "enable_skjoldr" boolean question alongside the
// other capability-gating questions (enable_rollback, enable_docker).

function makeRepoRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mk2-monday-onboard-test-"));
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "test" }));
  return dir;
}

function ctx(repoRoot: string) {
  return { repoRoot, sessionId: "test-session" } as any;
}

async function runPhase1(repoRoot: string): Promise<any> {
  return mondayOnboarding(ctx(repoRoot));
}

async function runPhase2(repoRoot: string, sessionId: string, scope: Record<string, unknown>): Promise<any> {
  return mondayOnboarding(ctx(repoRoot), { phase: 2, session_id: sessionId, scope });
}

async function runPhase3(repoRoot: string, sessionId: string, answers: Record<string, boolean | string>): Promise<any> {
  return mondayOnboarding(ctx(repoRoot), { phase: 3, session_id: sessionId, answers });
}

const GENERAL_DEV_SCOPE = {
  deployment_name: "test-deploy",
  vertical: "general" as const,
  approver_identity: "Justin Hughes",
  environment: "dev" as const,
};

async function answerAllTrue(repoRoot: string, sessionId: string, questions: any[]): Promise<any> {
  const answers: Record<string, boolean> = {};
  for (const q of questions) answers[q.id] = true;
  return runPhase3(repoRoot, sessionId, answers);
}

// ─── Phase 1 ────────────────────────────────────────────────────────────────

test("phase 1 returns a session_id and awaiting_scope status with instructions for phase 2", async () => {
  const result = await runPhase1(makeRepoRoot());
  assert.equal(result.phase, 1);
  assert.equal(result.status, "awaiting_scope");
  assert.ok(result.session_id.startsWith("onboard-"));
  assert.match(result.instructions, /phase: 2/);
});

test("phase 1 issues a distinct session_id on each call, even back-to-back in the same millisecond (the fix)", async () => {
  // Old id was sha256Hex(`onboarding:${ctx.sessionId}:${Date.now()}`).slice(0,16)
  // — Date.now() plus a sessionId that's constant for the whole test made two
  // back-to-back calls collide on the exact same session_id. Verified directly
  // before fixing (this assertion failed on the old code). Fixed by adding real
  // randomness (crypto.randomBytes), matching the pattern already used by
  // core/receipts.ts (runId) and core/knownGood.ts (kgsId).
  const repoRoot = makeRepoRoot();
  const a = await runPhase1(repoRoot);
  const b = await runPhase1(repoRoot);
  assert.notEqual(a.session_id, b.session_id);
});

// ─── Phase 2 — scope validation ────────────────────────────────────────────

test("phase 2 rejects an incomplete/invalid scope with specific field errors", async () => {
  const repoRoot = makeRepoRoot();
  const p1 = await runPhase1(repoRoot);
  const result = await runPhase2(repoRoot, p1.session_id, { vertical: "not-a-real-vertical" });
  assert.equal(result.status, "scope_invalid");
  assert.ok(result.errors.some((e: string) => e.includes("deployment_name")));
  assert.ok(result.errors.some((e: string) => e.includes("vertical must be one of")));
  assert.ok(result.errors.some((e: string) => e.includes("approver_identity")));
  assert.ok(result.errors.some((e: string) => e.includes("environment must be one of")));
});

// ─── Phase 2 — question selection by scope ─────────────────────────────────

test("phase 2 asks only the core unconditional questions for a general/dev scope, including the fixed enable_skjoldr", async () => {
  const repoRoot = makeRepoRoot();
  const p1 = await runPhase1(repoRoot);
  const result = await runPhase2(repoRoot, p1.session_id, GENERAL_DEV_SCOPE);

  const ids = result.questions.map((q: any) => q.id);
  assert.deepEqual(
    ids.sort(),
    [
      "daemon_secret_required",
      "enable_docker",
      "enable_monday_hil",
      "enable_rollback",
      "enable_skjoldr",
      "receipts_enabled",
      "write_enabled",
    ].sort()
  );
});

test("phase 2 adds production-specific questions and substitutes the approver identity into the text", async () => {
  const repoRoot = makeRepoRoot();
  const p1 = await runPhase1(repoRoot);
  const result = await runPhase2(repoRoot, p1.session_id, { ...GENERAL_DEV_SCOPE, environment: "production" });

  const ids = result.questions.map((q: any) => q.id);
  assert.ok(ids.includes("genesis_ready"));
  assert.ok(ids.includes("production_identity_verified"));

  const idQ = result.questions.find((q: any) => q.id === "production_identity_verified");
  assert.match(idQ.question, /"Justin Hughes"/);
  assert.ok(!idQ.question.includes("{approver_identity}"));
});

test("phase 2 adds healthcare-specific questions for a healthcare vertical", async () => {
  const repoRoot = makeRepoRoot();
  const p1 = await runPhase1(repoRoot);
  const result = await runPhase2(repoRoot, p1.session_id, { ...GENERAL_DEV_SCOPE, vertical: "healthcare" });
  const ids = result.questions.map((q: any) => q.id);
  assert.ok(ids.includes("phi_policy_confirmed"));
  assert.ok(ids.includes("phi_in_scope"));
  assert.ok(!ids.includes("audit_reads_required"));
});

test("phase 2 adds finance-specific questions for a finance vertical", async () => {
  const repoRoot = makeRepoRoot();
  const p1 = await runPhase1(repoRoot);
  const result = await runPhase2(repoRoot, p1.session_id, { ...GENERAL_DEV_SCOPE, vertical: "finance" });
  const ids = result.questions.map((q: any) => q.id);
  assert.ok(ids.includes("audit_reads_required"));
  assert.ok(ids.includes("retention_policy_defined"));
});

test("phase 2 adds the legal-specific question for a legal vertical", async () => {
  const repoRoot = makeRepoRoot();
  const p1 = await runPhase1(repoRoot);
  const result = await runPhase2(repoRoot, p1.session_id, { ...GENERAL_DEV_SCOPE, vertical: "legal" });
  const ids = result.questions.map((q: any) => q.id);
  assert.ok(ids.includes("privilege_boundary_defined"));
});

test("phase 2 adds the Squad question for a nonprofit vertical", async () => {
  const repoRoot = makeRepoRoot();
  const p1 = await runPhase1(repoRoot);
  const result = await runPhase2(repoRoot, p1.session_id, { ...GENERAL_DEV_SCOPE, vertical: "nonprofit" });
  const ids = result.questions.map((q: any) => q.id);
  assert.ok(ids.includes("squad_connected"));
});

test("phase 2 adds the FedRAMP question for a government vertical", async () => {
  const repoRoot = makeRepoRoot();
  const p1 = await runPhase1(repoRoot);
  const result = await runPhase2(repoRoot, p1.session_id, { ...GENERAL_DEV_SCOPE, vertical: "government" });
  const ids = result.questions.map((q: any) => q.id);
  assert.ok(ids.includes("fedramp_required"));
});

test("phase 2 merges in module registry onboarding questions alongside the core bank", async () => {
  const repoRoot = makeRepoRoot();
  fs.mkdirSync(path.join(repoRoot, "config"), { recursive: true });
  fs.writeFileSync(
    path.join(repoRoot, "config", "module-registry.json"),
    JSON.stringify({
      schema: "auernyx.module-registry.v1",
      modules: [
        {
          id: "test-module",
          name: "Test Module",
          onboarding: { question_id: "custom_module_flag", question: "Enable the test module?", type: "boolean" },
        },
      ],
    })
  );

  const p1 = await runPhase1(repoRoot);
  const result = await runPhase2(repoRoot, p1.session_id, GENERAL_DEV_SCOPE);
  const ids = result.questions.map((q: any) => q.id);
  assert.ok(ids.includes("custom_module_flag"));
});

// ─── Phase 3 — session/answer validation ───────────────────────────────────

test("phase 3 requires a session_id", async () => {
  const result = await mondayOnboarding(ctx(makeRepoRoot()), { phase: 3, answers: {} });
  assert.equal((result as any).status, "session_id_required");
});

test("phase 3 reports session_not_found for an unknown or nonexistent session_id", async () => {
  const result = await runPhase3(makeRepoRoot(), "onboard-does-not-exist", {});
  assert.equal(result.status, "session_not_found");
});

test("phase 3 rejects incomplete boolean answers with specific field errors", async () => {
  const repoRoot = makeRepoRoot();
  const p1 = await runPhase1(repoRoot);
  const p2 = await runPhase2(repoRoot, p1.session_id, GENERAL_DEV_SCOPE);

  const result = await runPhase3(repoRoot, p1.session_id, { write_enabled: true });
  assert.equal(result.status, "answers_invalid");
  const remainingIds = p2.questions.map((q: any) => q.id).filter((id: string) => id !== "write_enabled");
  for (const id of remainingIds) {
    assert.ok(result.errors.some((e: string) => e.includes(`"${id}"`)), `expected an error mentioning ${id}`);
  }
});

test("phase 3 rejects a non-boolean value for a boolean question", async () => {
  const repoRoot = makeRepoRoot();
  const p1 = await runPhase1(repoRoot);
  const p2 = await runPhase2(repoRoot, p1.session_id, GENERAL_DEV_SCOPE);
  const answers: Record<string, boolean | string> = {};
  for (const q of p2.questions) answers[q.id] = "yes"; // wrong type, should be boolean
  const result = await runPhase3(repoRoot, p1.session_id, answers);
  assert.equal(result.status, "answers_invalid");
});

// ─── Phase 3 — recommended config generation ───────────────────────────────

test("phase 3 happy path returns a complete recommended allowlist and config patch", async () => {
  const repoRoot = makeRepoRoot();
  const p1 = await runPhase1(repoRoot);
  const p2 = await runPhase2(repoRoot, p1.session_id, GENERAL_DEV_SCOPE);
  const result = await answerAllTrue(repoRoot, p1.session_id, p2.questions);

  assert.equal(result.status, "complete");
  assert.ok(result.recommended_allowlist.allowedCapabilities.includes("scanRepo"));
  assert.equal(result.recommended_config_patch.writeEnabled, true);
  assert.equal(result.recommended_config_patch.governance.approverIdentity, "Justin Hughes");
  assert.ok(Array.isArray(result.apply_steps));
  assert.equal(result.apply_steps.length, 5);
});

test("regression (the fix): answering enable_skjoldr true recommends all 6 skjoldrFirewall capabilities, false recommends none", async () => {
  const repoRoot = makeRepoRoot();

  const p1 = await runPhase1(repoRoot);
  const p2 = await runPhase2(repoRoot, p1.session_id, GENERAL_DEV_SCOPE);
  const trueResult = await answerAllTrue(repoRoot, p1.session_id, p2.questions);
  const skjoldrCapsTrue = trueResult.recommended_allowlist.allowedCapabilities.filter((c: string) =>
    c.toLowerCase().includes("skjoldr")
  );
  assert.deepEqual(
    skjoldrCapsTrue.sort(),
    [
      "skjoldrFirewallStatus",
      "skjoldrFirewallAdviseInboundRuleSets",
      "skjoldrFirewallExportBaseline",
      "skjoldrFirewallRestoreBaseline",
      "skjoldrFirewallApplyProfile",
      "skjoldrFirewallApplyRulesetFile",
    ].sort()
  );

  const p1b = await runPhase1(repoRoot);
  const p2b = await runPhase2(repoRoot, p1b.session_id, GENERAL_DEV_SCOPE);
  const answersFalse: Record<string, boolean> = {};
  for (const q of p2b.questions) answersFalse[q.id] = false;
  const falseResult = await runPhase3(repoRoot, p1b.session_id, answersFalse);
  const skjoldrCapsFalse = falseResult.recommended_allowlist.allowedCapabilities.filter((c: string) =>
    c.toLowerCase().includes("skjoldr")
  );
  assert.deepEqual(skjoldrCapsFalse, []);
});

test("enable_monday_hil gates the 4 Monday capabilities, enable_rollback/enable_docker gate their own tier-2 capability", async () => {
  const repoRoot = makeRepoRoot();
  const p1 = await runPhase1(repoRoot);
  const p2 = await runPhase2(repoRoot, p1.session_id, GENERAL_DEV_SCOPE);
  const answers: Record<string, boolean> = {};
  for (const q of p2.questions) answers[q.id] = false;
  answers["enable_monday_hil"] = true;
  answers["enable_rollback"] = true;

  const result = await runPhase3(repoRoot, p1.session_id, answers);
  const caps: string[] = result.recommended_allowlist.allowedCapabilities;
  assert.ok(caps.includes("mondayInfractionReview"));
  assert.ok(caps.includes("mondaySystemStatus"));
  assert.ok(caps.includes("mondayTier2Review"));
  assert.ok(caps.includes("mondayOnboarding"));
  assert.ok(caps.includes("rollbackKnownGood"));
  assert.ok(!caps.includes("docker"));
  assert.ok(!caps.includes("searchDocApply")); // write_enabled was false
});

test("daemon_secret_required=true produces a placeholder, not an empty secret", async () => {
  const repoRoot = makeRepoRoot();
  const p1 = await runPhase1(repoRoot);
  const p2 = await runPhase2(repoRoot, p1.session_id, GENERAL_DEV_SCOPE);
  const answers: Record<string, boolean> = {};
  for (const q of p2.questions) answers[q.id] = false;
  answers["daemon_secret_required"] = true;

  const result = await runPhase3(repoRoot, p1.session_id, answers);
  assert.match(result.recommended_config_patch.daemon.secret, /AUERNYX_SECRET/);
});

test("an out-of-range phase (0, 4, negative) reports invalid_phase", async () => {
  const repoRoot = makeRepoRoot();
  for (const phase of [0, 4, -1]) {
    const result = (await mondayOnboarding(ctx(repoRoot), { phase })) as any;
    assert.equal(result.status, "invalid_phase");
  }
});

// ─── Documented, not fixed: a real but currently-dormant gap ───────────────

test(
  "known, documented gap (not fixed here — a real design decision, not a one-line fix): " +
    "validateAnswers only checks 'boolean' typed questions; a module-registry question of type " +
    "'string' or 'enum' can be left completely unanswered and phase 3 still completes",
  async () => {
    const repoRoot = makeRepoRoot();
    fs.mkdirSync(path.join(repoRoot, "config"), { recursive: true });
    fs.writeFileSync(
      path.join(repoRoot, "config", "module-registry.json"),
      JSON.stringify({
        schema: "auernyx.module-registry.v1",
        modules: [
          {
            id: "test-module",
            name: "Test Module",
            onboarding: { question_id: "region", question: "Which region?", type: "string" },
          },
        ],
      })
    );

    const p1 = await runPhase1(repoRoot);
    const p2 = await runPhase2(repoRoot, p1.session_id, GENERAL_DEV_SCOPE);
    assert.ok(p2.questions.some((q: any) => q.id === "region"));

    const answers: Record<string, boolean> = {};
    for (const q of p2.questions) {
      if (q.type === "boolean") answers[q.id] = true;
      // deliberately never answer "region"
    }
    const result = await runPhase3(repoRoot, p1.session_id, answers);
    // Pinning actual current behavior: completes anyway, not endorsing it.
    assert.equal(result.status, "complete");
  }
);
