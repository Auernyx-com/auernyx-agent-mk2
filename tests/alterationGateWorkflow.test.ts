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
