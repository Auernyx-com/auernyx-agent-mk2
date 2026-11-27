import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "fs";
import * as path from "path";

// Coverage for two findings in .github/workflows/mk2-alteration-gate.yml,
// found by an independent audit of SQUAD (Auernyx-com/SQUAD), which adopted
// this exact workflow as a governance pattern -- SQUAD's copy had both bugs
// (fixed 2026-09-07), and diffing the two confirmed this, the original, had
// them too.
//
// 1. THE SCRIPT-INJECTION BUG (high). github.event.pull_request.head.ref --
//    the PR's source branch name, fully controlled by whoever opens the PR
//    -- was spliced directly into `run:` bash blocks via `${{ }}`. GitHub
//    Actions performs this substitution as a raw text splice into the step
//    script BEFORE bash ever runs, so wrapping the expression in double
//    quotes does not protect against it: a branch name containing a `"`
//    followed by shell metacharacters (e.g. a `$(...)` command
//    substitution) breaks out of the quotes and executes as a real shell
//    command. Fixed by passing the value through `env:` instead (GitHub
//    Actions sets env vars as real environment variable values, never
//    spliced into the script text) and referencing it in bash as
//    "$HEAD_REF" / "$BASE_REF".
//
// 2. THE MERE-REQUEST-COUNTS-AS-AUTHORIZATION BUG (medium). The
//    auto-authorize job's allowlist check treated being *assigned* to a PR
//    or merely *requested* as a reviewer (neither implies the person did
//    anything) the same as an actual approval. Fixed by dropping assignee/
//    requested-reviewer logins from the authorization chain, leaving only
//    actual approvals and self-authorship by an allowlisted login.
//
// This can't spin up a real Actions runner, so it asserts against the
// workflow file's own source text -- same approach as SQUAD's
// tests/test_alteration_gate_workflow.py, which covers the identical fix
// on that repo's copy.

// __dirname is dist/tests at runtime (tsconfig.test.json compiles with
// rootDir "./" into outDir "./dist", mirroring the source tree) -- two
// levels up reaches the repo root, where .github/ actually lives (it's
// never copied into dist).
const WORKFLOW_PATH = path.join(__dirname, "..", "..", ".github", "workflows", "mk2-alteration-gate.yml");

function readWorkflow(): string {
  return fs.readFileSync(WORKFLOW_PATH, "utf8");
}

test("head_ref and base_ref are no longer spliced directly into run: blocks", () => {
  const content = readWorkflow();
  const vulnerableSnippets = [
    'git fetch origin "${{ github.event.pull_request.head.ref }}"',
    'git checkout "${{ github.event.pull_request.head.ref }}"',
    'git reset --hard "origin/${{ github.event.pull_request.head.ref }}"',
    'git fetch origin "${{ github.base_ref }}"',
  ];
  for (const snippet of vulnerableSnippets) {
    assert.ok(!content.includes(snippet), `vulnerable splice still present: ${snippet}`);
  }
});

test("head_ref and base_ref now flow through env", () => {
  const content = readWorkflow();
  const requiredSnippets = [
    "HEAD_REF: ${{ github.event.pull_request.head.ref }}",
    "BASE_REF: ${{ github.base_ref }}",
    'git fetch origin "$HEAD_REF"',
    'git checkout "$HEAD_REF"',
    'git reset --hard "origin/$HEAD_REF"',
    'git fetch origin "$BASE_REF"',
  ];
  for (const snippet of requiredSnippets) {
    assert.ok(content.includes(snippet), `expected snippet missing: ${snippet}`);
  }
});

test("authorization chain excludes assignees and requested reviewers", () => {
  const content = readWorkflow();
  assert.ok(
    !content.includes(
      "for login in assignee_logins + reviewer_logins + approved_reviewer_logins + [actor]:"
    ),
    "old, overly-permissive authorization chain is still present"
  );
  assert.ok(
    content.includes("for login in approved_reviewer_logins + [actor]:"),
    "expected the narrowed authorization chain"
  );
});

test("assignees and requested reviewers are still parsed for logging only", () => {
  const content = readWorkflow();
  assert.ok(content.includes('assignee_logins = parse_logins("ASSIGNEES_JSON")'));
  assert.ok(content.includes('reviewer_logins = parse_logins("REVIEWERS_JSON")'));
});

test("record commit gets a real test run, dispatched with the branch via env", () => {
  const content = readWorkflow();
  assert.ok(content.includes("gh workflow run ci-tests.yml"), "gate must dispatch ci-tests after pushing the record");
  assert.ok(content.includes('--ref "$HEAD_REF"'), "dispatch must take the branch from env, not a ${{ }} splice");
  assert.ok(content.includes("actions: write"), "dispatch needs actions: write");
  assert.ok(!/name:\s*['"]?test['"]?,\s*\n\s*head_sha/.test(content), "gate must never register a `test` check itself");
  const ci = fs.readFileSync(path.join(path.dirname(WORKFLOW_PATH), "ci-tests.yml"), "utf8");
  assert.ok(/\n\s*workflow_dispatch:/.test(ci), "ci-tests must accept workflow_dispatch");
});

// The record-in-first-push path (tools/open-pr.sh, 2026-11-27). The record
// file is named by branch because the PR number doesn't exist yet, so the
// trusted-record step must find the record by what the PR adds, not by a
// -pr-<N> file name. Trust still comes only from the live is_allowed check.
test("trusted record step finds the record by the PR diff, not by PR-number file name", () => {
  const content = readWorkflow();
  assert.ok(!content.includes('records/*-pr-"${PR_NUMBER}".json'), "old PR-number lookup still present");
  assert.ok(content.includes('git diff --name-only --diff-filter=AM "${BASE_SHA}...HEAD"'), "must look at what the PR adds");
  assert.ok(content.includes("BASE_SHA: ${{ github.event.pull_request.base.sha }}"), "base sha must come through env");
  assert.ok(content.includes('if [ "$OWN" -ne 1 ]'), "must vouch for exactly one own record or none");
  const step = content.slice(content.indexOf("name: Determine trusted record commit"));
  assert.ok(/if: steps\.check-allowlist\.outputs\.is_allowed == 'true'/.test(step.slice(0, 200)), "vouching must stay behind the live is_allowed check");
});

test("open-pr.sh commits the record as the author, without a skip-ci marker", () => {
  const script = fs.readFileSync(path.join(__dirname, "..", "..", "tools", "open-pr.sh"), "utf8");
  assert.ok(script.includes('RECORD_DIR="governance/alteration-program/authorization/records"'));
  assert.ok(script.includes("authorizedLogins"), "must refuse logins not on the allowlist");
  assert.ok(script.includes("date -u +%F"), "authorizedAt must use the UTC date (gate rejects future dates)");
  assert.ok(!/skip[ -]?ci/i.test(script.split("\n").filter((l) => l.includes("git commit")).join("\n")), "record commit must not carry a skip-ci marker");
  assert.ok(script.includes('"$BRANCH" = "main"'), "must refuse to run on main");
});

// Dependabot approval path (2026-11-27): nothing may push to a Dependabot
// branch; an approval re-runs the gate; the record is filed after merge.
test("Dependabot PRs: no robot pushes to their branch, approval re-runs the gate", () => {
  const content = readWorkflow();
  const dir = path.dirname(WORKFLOW_PATH);
  assert.ok(!fs.existsSync(path.join(dir, "dependabot-gate.yml")), "the intent-file robot must stay removed");
  assert.ok(/pull_request_review:\s*\n\s*types: \[submitted, dismissed\]/.test(content), "an approval must re-run the gate");
  const auto = content.slice(content.indexOf("  auto-authorize:"), content.indexOf("    runs-on:", content.indexOf("  auto-authorize:")));
  assert.ok(auto.includes("github.event.pull_request.user.login != 'dependabot[bot]'"), "record robot must skip Dependabot PRs");
  const job = content.slice(content.indexOf("  dependabot-approval:"), content.indexOf("  gate:\n"));
  assert.ok(job.includes("contents: read") && !job.includes("contents: write"), "approval job must be read-only");
  assert.ok(!/git push|git commit/.test(job), "approval job must never push");
  assert.ok(job.includes("ref: ${{ github.event.pull_request.base.sha }}"), "approval job must use main's rules, not the PR's");
  assert.ok(content.includes("MK2_DEPENDABOT_APPROVED_BY: ${{ needs.dependabot-approval.outputs.approved_by }}"));
  assert.ok(content.includes("MK2_IS_DEPENDABOT_PR: ${{ github.event.pull_request.user.login == 'dependabot[bot]' }}"));
});

test("on a review event the reviewer is not mistaken for the PR author", () => {
  const content = readWorkflow();
  assert.ok(
    content.includes("ACTOR:                  ${{ github.event_name == 'pull_request_review' && github.event.pull_request.user.login || github.actor }}"),
    "a review by an allowlisted login must not count as self-authorship of someone else's PR"
  );
});

test("after-merge Dependabot records are verified against GitHub and vouched with the PR's own record", () => {
  const content = readWorkflow();
  assert.ok(content.includes("rules.verifyBackfillRecord"), "backfill records must be re-checked against GitHub");
  assert.ok(content.includes("backfill_verified: ${{ steps.verify-backfill.outputs.backfill_verified }}"));
  assert.ok(content.includes("MK2_BACKFILL_VERIFIED: ${{ needs.auto-authorize.outputs.backfill_verified }}"));
  assert.ok(content.includes("records come from more than one commit -- nothing vouched."), "one commit must introduce all records");
  assert.ok(content.includes("const triggeredSha = context.payload.pull_request.head.sha;"), "gate re-register must compare with the PR head");
});
