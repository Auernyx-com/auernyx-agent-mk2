import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { isPathProtected } from "../core/governanceRefusal";
import { guardedWriteFile, guardedMkdir } from "../core/guardedFs";

// Found while adding coverage for previously-untested core modules, not from
// a symptom: isPathProtected's early-return for a path outside the repo root
// returns false ("not protected"), which for these guard functions means
// ALLOWED. The guard only actually protects specific paths *within* the repo
// (.git, node_modules, configured protectedPaths) — anything that resolves
// outside the repo root entirely sails through with zero protection at all,
// the opposite of what a function named "guarded" implies. Not currently
// exploited (today's two call sites — knownGood.ts, governanceSelfTest.ts —
// only ever pass repo-relative paths), but a latent trap for any future
// capability, or a path-construction bug, that ever passes an absolute path
// or a ".." traversal that escapes the repo.

function makeRepoRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mk2-guardedfs-test-"));
}

test("a path entirely outside the repo root is protected (blocked), not allowed", () => {
  const repoRoot = makeRepoRoot();
  const outside = path.join(os.tmpdir(), "definitely-outside-the-repo.txt");

  assert.equal(
    isPathProtected(repoRoot, outside, []),
    true,
    "a path with no relationship to repoRoot must never be treated as unprotected"
  );
});

test("a .. traversal that escapes the repo root is protected (blocked), not allowed", () => {
  const repoRoot = makeRepoRoot();
  const escaped = path.join(repoRoot, "..", "..", "etc", "passwd-equivalent");

  assert.equal(isPathProtected(repoRoot, escaped, []), true);
});

test("guardedWriteFile actually refuses when the target escapes the repo root", () => {
  const repoRoot = makeRepoRoot();
  const outsideTarget = path.join(os.tmpdir(), `mk2-escape-test-${process.pid}.txt`);
  // Cleanup guard in case a regression lets the write through.
  try {
    fs.unlinkSync(outsideTarget);
  } catch {
    /* didn't exist, fine */
  }

  assert.throws(() => guardedWriteFile(repoRoot, outsideTarget, "should never land here", "test", "escape attempt"));
  assert.equal(fs.existsSync(outsideTarget), false, "the escaping write must not have actually happened");
});

test("a path genuinely inside the repo root, with no configured protected paths, is not protected", () => {
  const repoRoot = makeRepoRoot();
  const inside = path.join(repoRoot, "some", "ordinary", "file.txt");

  assert.equal(isPathProtected(repoRoot, inside, []), false);

  // And the guarded write actually succeeds for a legitimate in-repo target.
  guardedMkdir(repoRoot, path.dirname(inside), "test", "setup");
  guardedWriteFile(repoRoot, inside, "fine", "test", "legitimate write");
  assert.equal(fs.readFileSync(inside, "utf8"), "fine");
});

test("the default configured protectedPaths still block writes inside the repo", () => {
  // No config/auernyx.config.json in this temp repo, so guardedWriteFile
  // loads DEFAULT_GOVERNANCE.protectedPaths (core/config.ts) rather than an
  // explicit list — exercising the real default a fresh deployment gets,
  // not a value only this test knows about.
  const repoRoot = makeRepoRoot();
  const protectedTarget = path.join(repoRoot, ".auernyx", "kintsugi", "active.policy.json");

  assert.equal(isPathProtected(repoRoot, protectedTarget, [".auernyx/kintsugi/active.policy.json"]), true);
  assert.throws(() => guardedWriteFile(repoRoot, protectedTarget, "nope", "test", "should be refused"));
});
