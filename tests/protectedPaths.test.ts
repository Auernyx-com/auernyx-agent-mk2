import assert from "node:assert/strict";
import test from "node:test";
import * as path from "path";
import { isProtectedWorkspacePath } from "../core/kintsugi/protectedPaths";

// First direct unit coverage for protectedPaths.ts. Fixed the same "escape
// the boundary = treated as exempt" pattern found and fixed in
// governanceRefusal.ts's isPathProtected — currently unreachable via this
// function's one real caller, but closed here too for consistency and to
// prevent a regression if this is ever called from a new site.

const root = "/workspace/repo";

test("a path outside the workspace root is protected, not exempt", () => {
  assert.equal(isProtectedWorkspacePath(root, "/etc/passwd"), true);
  assert.equal(isProtectedWorkspacePath(root, path.join(root, "..", "..", "outside.txt")), true);
});

test("the workspace root itself is not protected", () => {
  assert.equal(isProtectedWorkspacePath(root, root), false);
});

test("an ordinary in-workspace file is not protected", () => {
  assert.equal(isProtectedWorkspacePath(root, path.join(root, "src", "index.ts")), false);
});

test("known protected prefixes are blocked", () => {
  assert.equal(isProtectedWorkspacePath(root, path.join(root, ".auernyx", "state.json")), true);
  assert.equal(isProtectedWorkspacePath(root, path.join(root, "kintsugi", "x")), true);
  assert.equal(isProtectedWorkspacePath(root, path.join(root, ".vscode", "auernyx", "y")), true);
});

test("a path merely starting with a protected prefix as a substring is NOT blocked (segment-aware, not naive prefix match)", () => {
  // ".auernyx-backup" is not ".auernyx" or ".auernyx/..." — must not match.
  assert.equal(isProtectedWorkspacePath(root, path.join(root, ".auernyx-backup", "x")), false);
});

test("known protected content fragments (anywhere in the relative path) are blocked", () => {
  assert.equal(isProtectedWorkspacePath(root, path.join(root, "some", "ledger", "records", "x.json")), true);
  assert.equal(isProtectedWorkspacePath(root, path.join(root, "backup", "active.policy.json")), true);
});
