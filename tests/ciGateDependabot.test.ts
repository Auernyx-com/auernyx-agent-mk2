import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync, spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// Runs the real tools/ci_gate.py against throwaway git repos shaped like
// main + a PR branch, for the Dependabot rules added 2026-11-27:
//   - a Dependabot PR passes only on the approval the workflow verified
//   - every other PR is blocked while a Dependabot merge has no AVRS record
//   - after-merge records count only when verified and vouched like any other

const GATE = path.join(__dirname, "..", "..", "tools", "ci_gate.py");
const REC = "governance/alteration-program/authorization/records";
const DEP_AUTHOR = "dependabot[bot] <49699333+dependabot[bot]@users.noreply.github.com>";

function git(cwd: string, args: string[], env: Record<string, string> = {}) {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...env } }).trim();
}

function write(cwd: string, rel: string, content: string) {
  fs.mkdirSync(path.dirname(path.join(cwd, rel)), { recursive: true });
  fs.writeFileSync(path.join(cwd, rel), content);
}

function commit(cwd: string, msg: string, opts: { author?: string; date?: string } = {}) {
  git(cwd, ["add", "-A"]);
  const env: Record<string, string> = {};
  if (opts.date) {
    env.GIT_AUTHOR_DATE = opts.date;
    env.GIT_COMMITTER_DATE = opts.date;
  }
  const args = ["commit", "-q", "--allow-empty", "-m", msg];
  if (opts.author) args.push(`--author=${opts.author}`);
  git(cwd, args, env);
  return git(cwd, ["rev-parse", "HEAD"]);
}

function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mk2-gate-"));
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.name", "Test"]);
  git(dir, ["config", "user.email", "test@example.invalid"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
  fs.mkdirSync(path.join(dir, "tools"));
  fs.copyFileSync(GATE, path.join(dir, "tools", "ci_gate.py"));
  write(dir, "governance/alteration-program/authorization/allowlist.json", JSON.stringify({ authorizedLogins: ["Ghostwolf101"] }));
  write(dir, "package.json", "{}\n");
  write(dir, "package-lock.json", "{}\n");
  commit(dir, "base", { date: "2026-11-01T00:00:00Z" });
  return dir;
}

function dependabotMerge(dir: string, n: number, date = "2026-11-27T12:00:00Z") {
  write(dir, "package-lock.json", `{"bump":${n}}\n`);
  return commit(dir, `deps: bump x from 1.0.${n} to 1.0.${n + 1} (#${n})`, { author: DEP_AUTHOR, date });
}

function ownRecord(today = "2026-11-27") {
  return JSON.stringify({ authorizedBy: "Ghostwolf101", authorizedAt: today, reason: "test change" }, null, 2) + "\n";
}

function backfill(n: number, mergeSha: string) {
  return JSON.stringify({
    kind: "dependabot-merge", pullRequest: n, change: "deps: bump x", approvedBy: "Ghostwolf101",
    approvedAt: "2026-11-27", approvalReviewId: 7, approvedCommit: "d57acf9", mergeCommit: mergeSha,
    mergedAt: "2026-11-27T12:00:00Z", authorizedBy: "Ghostwolf101", authorizedAt: "2026-11-27", reason: "after-merge record"
  }, null, 2) + "\n";
}

function gate(dir: string, env: Record<string, string>, args: string[] = []) {
  const r = spawnSync("python3", [path.join(dir, "tools", "ci_gate.py"), ...args], { cwd: dir, encoding: "utf8", env: { ...process.env, ...env } });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

// ── Dependabot PR path ──────────────────────────────────────────────────────

function dependabotBranch() {
  const dir = repo();
  const base = git(dir, ["rev-parse", "HEAD"]);
  git(dir, ["checkout", "-q", "-b", "dependabot/npm/x"]);
  write(dir, "package.json", '{"x":"1.0.1"}\n');
  write(dir, "package-lock.json", '{"x":"1.0.1"}\n');
  commit(dir, "deps: bump x", { author: DEP_AUTHOR });
  return { dir, base };
}

test("Dependabot PR with a verified approval passes with no record file", () => {
  const { dir, base } = dependabotBranch();
  const r = gate(dir, { MK2_BASE_REF: base, MK2_IS_DEPENDABOT_PR: "true", MK2_DEPENDABOT_APPROVED_BY: "Ghostwolf101" });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /PASS \(Dependabot update approved by Ghostwolf101/);
});

test("Dependabot PR without approval fails and says why", () => {
  const { dir, base } = dependabotBranch();
  const r = gate(dir, { MK2_BASE_REF: base, MK2_IS_DEPENDABOT_PR: "true", MK2_DEPENDABOT_REASON: "waiting for approval: test" });
  assert.notEqual(r.code, 0);
  assert.match(r.out, /waiting for approval/);
});

test("Dependabot PR approved by a login not on the allowlist fails", () => {
  const { dir, base } = dependabotBranch();
  const r = gate(dir, { MK2_BASE_REF: base, MK2_IS_DEPENDABOT_PR: "true", MK2_DEPENDABOT_APPROVED_BY: "someone-else" });
  assert.notEqual(r.code, 0);
});

test("Dependabot PR touching more than the manifests fails even when approved", () => {
  const { dir, base } = dependabotBranch();
  write(dir, "core/evil.ts", "x\n");
  commit(dir, "sneak", { author: DEP_AUTHOR });
  const r = gate(dir, { MK2_BASE_REF: base, MK2_IS_DEPENDABOT_PR: "true", MK2_DEPENDABOT_APPROVED_BY: "Ghostwolf101" });
  assert.notEqual(r.code, 0);
  assert.match(r.out, /core\/evil\.ts/);
});

// ── every other PR: Dependabot merges must be recorded ──────────────────────

function featureBranchAfter(dir: string) {
  const base = git(dir, ["rev-parse", "HEAD"]);
  git(dir, ["checkout", "-q", "-b", "feature"]);
  write(dir, "core/a.ts", "change\n");
  commit(dir, "feature work");
  return base;
}

test("normal PR is blocked while a Dependabot merge on main has no record, naming the PR", () => {
  const dir = repo();
  dependabotMerge(dir, 203);
  const base = featureBranchAfter(dir);
  write(dir, `${REC}/2026-11-27-branch-feature.json`, ownRecord());
  const sha = commit(dir, "record");
  const r = gate(dir, { MK2_BASE_REF: base, MK2_RECORD_COMMIT_SHA: sha });
  assert.notEqual(r.code, 0);
  assert.match(r.out, /#203/);
  assert.match(r.out, /tools\/open-pr\.sh/);
});

test("--list-unrecorded-dependabot lists exactly the unrecorded merges", () => {
  const dir = repo();
  dependabotMerge(dir, 203);
  dependabotMerge(dir, 204);
  const r = gate(dir, {}, ["--list-unrecorded-dependabot", "HEAD"]);
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(r.out.trim().split("\n"), ["204", "203"]);
});

test("Dependabot merges before the rule started (2026-11-27) are not required", () => {
  const dir = repo();
  dependabotMerge(dir, 197, "2026-11-09T12:00:00Z");
  const base = featureBranchAfter(dir);
  write(dir, `${REC}/2026-11-27-branch-feature.json`, ownRecord());
  const sha = commit(dir, "record");
  const r = gate(dir, { MK2_BASE_REF: base, MK2_RECORD_COMMIT_SHA: sha });
  assert.equal(r.code, 0, r.out);
});

test("normal PR filing the after-merge record in the same commit as its own record passes", () => {
  const dir = repo();
  const merge = dependabotMerge(dir, 203);
  const base = featureBranchAfter(dir);
  write(dir, `${REC}/2026-11-27-branch-feature.json`, ownRecord());
  write(dir, `${REC}/2026-11-27-dependabot-pr-203.json`, backfill(203, merge));
  const sha = commit(dir, "records");
  const r = gate(dir, { MK2_BASE_REF: base, MK2_RECORD_COMMIT_SHA: sha, MK2_BACKFILL_VERIFIED: "true" });
  assert.equal(r.code, 0, r.out);
});

test("after-merge record not verified against GitHub fails", () => {
  const dir = repo();
  const merge = dependabotMerge(dir, 203);
  const base = featureBranchAfter(dir);
  write(dir, `${REC}/2026-11-27-branch-feature.json`, ownRecord());
  write(dir, `${REC}/2026-11-27-dependabot-pr-203.json`, backfill(203, merge));
  const sha = commit(dir, "records");
  const r = gate(dir, { MK2_BASE_REF: base, MK2_RECORD_COMMIT_SHA: sha });
  assert.notEqual(r.code, 0);
  assert.match(r.out, /MK2_BACKFILL_VERIFIED/);
});

test("after-merge record in a different commit from the vouched one fails", () => {
  const dir = repo();
  const merge = dependabotMerge(dir, 203);
  const base = featureBranchAfter(dir);
  write(dir, `${REC}/2026-11-27-branch-feature.json`, ownRecord());
  const sha = commit(dir, "own record");
  write(dir, `${REC}/2026-11-27-dependabot-pr-203.json`, backfill(203, merge));
  commit(dir, "later backfill");
  const r = gate(dir, { MK2_BASE_REF: base, MK2_RECORD_COMMIT_SHA: sha, MK2_BACKFILL_VERIFIED: "true" });
  assert.notEqual(r.code, 0);
  assert.match(r.out, /does not match/);
});

test("a PR carrying only after-merge records has no authorization of its own and fails", () => {
  const dir = repo();
  const merge = dependabotMerge(dir, 203);
  const base = featureBranchAfter(dir);
  write(dir, `${REC}/2026-11-27-dependabot-pr-203.json`, backfill(203, merge));
  const sha = commit(dir, "backfill only");
  const r = gate(dir, { MK2_BASE_REF: base, MK2_RECORD_COMMIT_SHA: sha, MK2_BACKFILL_VERIFIED: "true" });
  assert.notEqual(r.code, 0);
  assert.match(r.out, /own authorization/);
});

test("after-merge record whose number doesn't match its file name fails", () => {
  const dir = repo();
  const merge = dependabotMerge(dir, 203);
  const base = featureBranchAfter(dir);
  write(dir, `${REC}/2026-11-27-branch-feature.json`, ownRecord());
  write(dir, `${REC}/2026-11-27-dependabot-pr-203.json`, backfill(999, merge));
  const sha = commit(dir, "records");
  const r = gate(dir, { MK2_BASE_REF: base, MK2_RECORD_COMMIT_SHA: sha, MK2_BACKFILL_VERIFIED: "true" });
  assert.notEqual(r.code, 0);
});

test("ordinary PR with no Dependabot merges behaves exactly as before", () => {
  const dir = repo();
  const base = featureBranchAfter(dir);
  write(dir, `${REC}/2026-11-27-branch-feature.json`, ownRecord());
  const sha = commit(dir, "record");
  assert.equal(gate(dir, { MK2_BASE_REF: base, MK2_RECORD_COMMIT_SHA: sha }).code, 0);
  assert.notEqual(gate(dir, { MK2_BASE_REF: base, MK2_RECORD_COMMIT_SHA: "0".repeat(40) }).code, 0, "forged-record check still applies");
});
