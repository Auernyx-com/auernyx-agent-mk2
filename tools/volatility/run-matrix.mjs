import { execSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";

function sh(cmd, opts = {}) {
  console.log(`\n$ ${cmd}`);
  execSync(cmd, { stdio: "inherit", ...opts });
}
function shOut(cmd, opts = {}) {
  return execSync(cmd, { stdio: "pipe", encoding: "utf8", ...opts }).trim();
}

function runRequired(dir, requires) {
  if (requires.includes("install")) sh("npm ci", { cwd: dir });
  if (requires.includes("build")) sh("npm run build", { cwd: dir });
  if (requires.includes("test")) sh("npm test", { cwd: dir });
  if (requires.includes("baseline")) {
    sh("npm run baseline:pre", { cwd: dir });
    sh("npm run baseline:post", { cwd: dir });
  }
}

function main() {
  const matrixPath = process.argv[2] || "branches/compat-matrix.generated.json";
  const matrix = JSON.parse(readFileSync(matrixPath, "utf8"));

  const stagingRef = `origin/${matrix.stagingBranch}`;
  const branches = matrix.branches || [];

  if (!matrix.stagingBranch) throw new Error("Matrix missing stagingBranch");
  if (!Array.isArray(branches) || branches.length === 0) throw new Error("Matrix branches empty");

  const root = process.cwd();
  const workRoot = path.join(root, ".worktrees");
  mkdirSync(workRoot, { recursive: true });

  sh("git fetch --all --prune");

  const stagingSha = shOut(`git rev-parse ${stagingRef}`);
  console.log(`\nStaging: ${stagingRef} @ ${stagingSha}`);

  const results = [];

  for (const b of branches) {
    const branch = b.name;
    const requires = b.requires || [];
    const wtDir = path.join(workRoot, branch.replace(/[^\w.-]+/g, "_"));

    try {
      try { sh(`git worktree remove --force \"${wtDir}\"`); } catch {}
      try { rmSync(wtDir, { recursive: true, force: true }); } catch {}

      console.log(`\n=== Testing ${branch} (requires: ${requires.join(", ")}) ===\n`);

      sh(`git worktree add \"${wtDir}\" \"origin/${branch}\"`);
      sh(`git checkout -B \"ci/merge-${branch.replace(/[^\w.-]+/g, "_")}\"`, { cwd: wtDir });
      sh(`git merge --no-edit ${stagingSha}`, { cwd: wtDir });

      runRequired(wtDir, requires);

      results.push({ branch, ok: true });
      console.log(`\n✅ PASS: ${branch}`);
    } catch {
      results.push({ branch, ok: false });
      console.log(`\n❌ FAIL: ${branch}`);
    } finally {
      try { sh(`git worktree remove --force \"${wtDir}\"`); } catch {}
      try { rmSync(wtDir, { recursive: true, force: true }); } catch {}
    }
  }

  console.log("\n=== SUMMARY ===");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.branch}`);
  const failed = results.filter(r => !r.ok);
  if (failed.length) process.exit(1);
}

main();
