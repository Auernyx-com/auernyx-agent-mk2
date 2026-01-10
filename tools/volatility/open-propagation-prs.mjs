import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

function sh(cmd, opts = {}) {
  console.log(`\n$ ${cmd}`);
  execSync(cmd, { stdio: "inherit", ...opts });
}
function shOut(cmd, opts = {}) {
  return execSync(cmd, { stdio: "pipe", encoding: "utf8", ...opts }).trim();
}

function main() {
  const matrixPath = process.argv[2] || "branches/compat-matrix.generated.json";
  const matrix = JSON.parse(readFileSync(matrixPath, "utf8"));

  const staging = matrix.stagingBranch;
  const branches = matrix.branches?.map(b => b.name) || [];
  if (!staging || branches.length === 0) throw new Error("Matrix missing stagingBranch or branches");

  sh("git fetch --all --prune");

  const stagingRef = `origin/${staging}`;
  const stagingSha = shOut(`git rev-parse ${stagingRef}`);
  const shortSha = stagingSha.slice(0, 7);

  for (const target of branches) {
    const head = `sync/platform-${shortSha}/${target.replace(/[^\w.-]+/g, "_")}`;

    console.log(`\n==============================`);
    console.log(`Creating PR -> ${target}`);
    console.log(`Head branch: ${head}`);
    console.log(`==============================\n`);

    // Create/update head branch from target, merge staging, push
    sh(`git checkout -B "${head}" "origin/${target}"`);
    sh(`git merge --no-edit ${stagingSha}`);
    sh(`git push -u origin "${head}" --force-with-lease`);

    // Create PR if missing, otherwise update is fine (push updates it)
    // gh pr create fails if PR exists; we handle that gracefully
    try {
      sh(
        `gh pr create --base "${target}" --head "${head}" ` +
          `--title "Sync platform contract (${shortSha}) -> ${target}" ` +
          `--body "Automated propagation from staging: ${stagingRef}\\n\\n- Staging SHA: ${stagingSha}\\n- Target: ${target}\\n\\nThis PR exists because Mk2/platform changed and passed the volatility gate."`
      );
    } catch {
      console.log(`PR likely already exists for ${target}. Updating via push is done.`);
    }
  }
}

main();
