import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  loadVsCodePolicy,
  DEFAULT_VSCODE_POLICY,
  computePlanHash,
  computePseudoDiff,
  canonGitignoreStatus,
} from "../core/vscodePolicy";

function makeRepoRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mk2-vscodepolicy-test-"));
}

test("loadVsCodePolicy returns the default policy when no config file exists", () => {
  assert.deepEqual(loadVsCodePolicy(makeRepoRoot()), DEFAULT_VSCODE_POLICY);
});

test("loadVsCodePolicy returns the default policy for a corrupted config file", () => {
  const repoRoot = makeRepoRoot();
  fs.mkdirSync(path.join(repoRoot, "config"), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, "config", "vscode-policy.json"), "{not valid json");
  assert.deepEqual(loadVsCodePolicy(repoRoot), DEFAULT_VSCODE_POLICY);
});

test("loadVsCodePolicy deep-merges a partial override without losing untouched defaults", () => {
  const repoRoot = makeRepoRoot();
  fs.mkdirSync(path.join(repoRoot, "config"), { recursive: true });
  fs.writeFileSync(
    path.join(repoRoot, "config", "vscode-policy.json"),
    JSON.stringify({ write_gate: { required: false } })
  );

  const policy = loadVsCodePolicy(repoRoot);
  assert.equal(policy.write_gate.required, false); // overridden
  assert.equal(policy.write_gate.cli_flag, "--apply"); // untouched sibling field preserved
  assert.deepEqual(policy.git_rules, DEFAULT_VSCODE_POLICY.git_rules); // untouched section preserved
});

test("loadVsCodePolicy falls back to default arrays when an override array field is malformed", () => {
  const repoRoot = makeRepoRoot();
  fs.mkdirSync(path.join(repoRoot, "config"), { recursive: true });
  fs.writeFileSync(
    path.join(repoRoot, "config", "vscode-policy.json"),
    JSON.stringify({ canon_paths: "not-an-array" })
  );
  assert.deepEqual(loadVsCodePolicy(repoRoot).canon_paths, DEFAULT_VSCODE_POLICY.canon_paths);
});

test("computePlanHash is deterministic for the same plan, and different for a different one", () => {
  const planA = { id: "p1", steps: [{ tool: { name: "scanRepo" } }] } as any;
  const planB = { id: "p2", steps: [{ tool: { name: "docker" } }] } as any;
  assert.equal(computePlanHash(planA), computePlanHash(planA));
  assert.notEqual(computePlanHash(planA), computePlanHash(planB));
});

test("computePlanHash handles undefined and unhashable (circular) input without throwing", () => {
  assert.equal(typeof computePlanHash(undefined), "string");

  const circular: any = { a: 1 };
  circular.self = circular;
  assert.doesNotThrow(() => computePlanHash(circular));
});

test("computePseudoDiff lists every proposed file and is stable for identical input", () => {
  const a = computePseudoDiff({ capability: "scanRepo", proposedFiles: ["a.ts", "b.ts"] });
  const b = computePseudoDiff({ capability: "scanRepo", proposedFiles: ["a.ts", "b.ts"] });
  assert.equal(a.text, b.text);
  assert.equal(a.sha256, b.sha256);
  assert.ok(a.text.includes("a.ts"));
  assert.ok(a.text.includes("b.ts"));
});

test("computePseudoDiff notes when no write targets are declared", () => {
  const result = computePseudoDiff({ proposedFiles: [] });
  assert.ok(result.text.includes("No file write targets"));
});

test("canonGitignoreStatus fails when .gitignore is missing entirely", () => {
  const result = canonGitignoreStatus(makeRepoRoot());
  assert.equal(result.ok, false);
  assert.deepEqual(result.missing, [".gitignore_missing"]);
});

test("canonGitignoreStatus reports exactly which required canon entries are missing", () => {
  const repoRoot = makeRepoRoot();
  fs.writeFileSync(path.join(repoRoot, ".gitignore"), "node_modules/\n.canon/\n");
  const result = canonGitignoreStatus(repoRoot);
  assert.equal(result.ok, false);
  assert.deepEqual(result.missing, ["var/canon/"]);
});

test("canonGitignoreStatus passes when both required canon entries are present, CRLF included", () => {
  const repoRoot = makeRepoRoot();
  fs.writeFileSync(path.join(repoRoot, ".gitignore"), ".canon/\r\nvar/canon/\r\n");
  const result = canonGitignoreStatus(repoRoot);
  assert.equal(result.ok, true);
  assert.deepEqual(result.missing, []);
});
