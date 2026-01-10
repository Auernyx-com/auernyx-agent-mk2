import { execSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { validateHandshake } from "./validate-handshake.mjs";

function sh(cmd, opts = {}) {
  return execSync(cmd, { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", ...opts }).trim();
}
function shLive(cmd, opts = {}) {
  console.log(`\n$ ${cmd}`);
  execSync(cmd, { stdio: "inherit", ...opts });
}

const BASE = "branches/compat-matrix.base.json";
const OUT = "branches/compat-matrix.generated.json";
const HANDSHAKE_PATH = ".mk2/handshake.json";
const SCHEMA_PATH = ".mk2/handshake.schema.json";

function listRemoteBranches() {
  // origin/<name> excluding HEAD and tags
  const lines = sh(`git for-each-ref --format=\"%(refname:short)\" refs/remotes/origin`).split("\n");
  return lines
    .map(s => s.trim())
    .filter(Boolean)
    .filter(r => r.startsWith("origin/"))
    .map(r => r.replace(/^origin\//, ""))
    .filter(b => b !== "HEAD");
}

function safeDirName(branch) {
  return branch.replace(/[^\w.-]+/g, "_");
}

function main() {
  shLive("git fetch --all --prune");

  const base = JSON.parse(readFileSync(BASE, "utf8"));
  const schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf8"));

  const exclude = new Set(base.defaults?.excludeLifecycles || []);
  const stagingBranch = base.stagingBranch || "staging/platform-canary";

  const branches = listRemoteBranches();

  const root = process.cwd();
  const workRoot = path.join(root, ".worktrees-registry");
  mkdirSync(workRoot, { recursive: true });

  const connected = [];

  for (const branch of branches) {
    const wtDir = path.join(workRoot, safeDirName(branch));
    try {
      // clean
      try { shLive(`git worktree remove --force \"${wtDir}\"`); } catch {}
      try { rmSync(wtDir, { recursive: true, force: true }); } catch {}

      shLive(`git worktree add \"${wtDir}\" \"origin/${branch}\"`);

      const hp = path.join(wtDir, HANDSHAKE_PATH);
      if (!existsSync(hp)) continue;

      const handshake = JSON.parse(readFileSync(hp, "utf8"));
      const { ok } = validateHandshake(handshake, schema);
      if (!ok) continue;

      if (exclude.has(handshake.lifecycle)) continue;

      connected.push({
        name: branch,
        requires: handshake.requires,
        owner: handshake.owner || "",
        lifecycle: handshake.lifecycle
      });
    } finally {
      try { shLive(`git worktree remove --force \"${wtDir}\"`); } catch {}
      try { rmSync(wtDir, { recursive: true, force: true }); } catch {}
    }
  }

  const out = {
    stagingBranch,
    generatedAt: new Date().toISOString(),
    branches: connected.map(b => ({ name: b.name, requires: b.requires }))
  };

  writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n");
  console.log(`\nWrote ${OUT} with ${out.branches.length} connected branches.`);
}

main();
