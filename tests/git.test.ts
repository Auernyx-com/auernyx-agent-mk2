import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";
import { detectGitRepoRoot, gitStatusPorcelain, isDirtyPorcelain } from "../core/git";

// First test coverage for core/git.ts. No bugs found — small, real subprocess
// wrapper, works exactly as documented against a real git repo.

function makeGitRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mk2-git-test-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
  fs.writeFileSync(path.join(dir, "a.txt"), "hello\n");
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", "initial"], { cwd: dir });
  return dir;
}

function makeNonGitDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mk2-notgit-test-"));
}

test("detectGitRepoRoot finds the real repo root from a subdirectory", () => {
  const repo = makeGitRepo();
  const sub = path.join(repo, "nested", "deeper");
  fs.mkdirSync(sub, { recursive: true });

  const result = detectGitRepoRoot(sub);
  assert.equal(result.ok, true);
  // Resolve both sides through realpath — on macOS /tmp is a symlink to
  // /private/tmp, and git reports the resolved path.
  assert.equal(fs.realpathSync(result.repoRoot!), fs.realpathSync(repo));
});

test("detectGitRepoRoot fails cleanly for a directory that isn't a git repo", () => {
  const dir = makeNonGitDir();
  const result = detectGitRepoRoot(dir);
  assert.equal(result.ok, false);
  assert.ok(result.error);
});

test("gitStatusPorcelain reports a clean tree as empty porcelain output", () => {
  const repo = makeGitRepo();
  const result = gitStatusPorcelain(repo);
  assert.equal(result.ok, true);
  assert.equal(result.porcelain, "");
});

test("gitStatusPorcelain reports an untracked file in its porcelain output", () => {
  const repo = makeGitRepo();
  fs.writeFileSync(path.join(repo, "untracked.txt"), "new\n");
  const result = gitStatusPorcelain(repo);
  assert.equal(result.ok, true);
  assert.match(result.porcelain!, /untracked\.txt/);
});

test("gitStatusPorcelain reports a modified tracked file in its porcelain output", () => {
  const repo = makeGitRepo();
  fs.writeFileSync(path.join(repo, "a.txt"), "changed\n");
  const result = gitStatusPorcelain(repo);
  assert.equal(result.ok, true);
  assert.match(result.porcelain!, /a\.txt/);
});

test("gitStatusPorcelain fails cleanly for a non-git directory", () => {
  const dir = makeNonGitDir();
  const result = gitStatusPorcelain(dir);
  assert.equal(result.ok, false);
});

test("isDirtyPorcelain is false for empty/whitespace-only/undefined porcelain, true for real content", () => {
  assert.equal(isDirtyPorcelain(undefined), false);
  assert.equal(isDirtyPorcelain(""), false);
  assert.equal(isDirtyPorcelain("   \n  "), false);
  assert.equal(isDirtyPorcelain(" M a.txt\n"), true);
});

test("a clean repo end to end: gitStatusPorcelain -> isDirtyPorcelain is false, and true after a real change", () => {
  const repo = makeGitRepo();
  assert.equal(isDirtyPorcelain(gitStatusPorcelain(repo).porcelain), false);

  fs.writeFileSync(path.join(repo, "a.txt"), "changed again\n");
  assert.equal(isDirtyPorcelain(gitStatusPorcelain(repo).porcelain), true);
});
