#!/usr/bin/env node
// File the AVRS record for every Dependabot merge on main that doesn't have
// one yet. Called by tools/open-pr.sh; safe to run by hand.
//
// Which merges need a record comes from tools/ci_gate.py (one source of
// truth); the facts in each record come from GitHub via the gh CLI and the
// same rules module the gate uses (.github/scripts/avrs-dependabot.js). The
// gate re-checks every fact against GitHub before trusting the file.
//
// Usage: node tools/backfill-dependabot-records.js [--ref origin/main] [--pr N ...] [--dry-run]
//   --pr N     record these PR numbers instead of asking ci_gate.py (testing)
//   --dry-run  print the records, write nothing
"use strict";

const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const rules = require(path.join(root, ".github", "scripts", "avrs-dependabot.js"));

function gh(apiPath) {
  return JSON.parse(execFileSync("gh", ["api", apiPath], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }));
}

function ghList(apiPath) {
  const out = [];
  for (let page = 1; page < 50; page++) {
    const sep = apiPath.includes("?") ? "&" : "?";
    const batch = gh(`${apiPath}${sep}per_page=100&page=${page}`);
    out.push(...batch);
    if (batch.length < 100) break;
  }
  return out;
}

function ghApi(repo) {
  const base = `repos/${repo}/pulls`;
  return {
    getPR: async (n) => gh(`${base}/${n}`),
    listCommits: async (n) => ghList(`${base}/${n}/commits`),
    listFiles: async (n) => ghList(`${base}/${n}/files`),
    listReviews: async (n) => ghList(`${base}/${n}/reviews`),
    getReview: async (n, id) => gh(`${base}/${n}/reviews/${id}`)
  };
}

function args(argv) {
  const a = { ref: "origin/main", prs: [], dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--ref") a.ref = argv[++i];
    else if (argv[i] === "--pr") a.prs.push(Number(argv[++i]));
    else if (argv[i] === "--dry-run") a.dryRun = true;
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  return a;
}

async function main() {
  const a = args(process.argv.slice(2));
  const repo = execFileSync("gh", ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"], { encoding: "utf8", cwd: root }).trim();
  const allowlist = JSON.parse(fs.readFileSync(path.join(root, "governance/alteration-program/authorization/allowlist.json"), "utf8")).authorizedLogins || [];

  const prs = a.prs.length
    ? a.prs
    : execFileSync("python3", [path.join(root, "tools", "ci_gate.py"), "--list-unrecorded-dependabot", a.ref], { encoding: "utf8", cwd: root })
        .split("\n").map((x) => x.trim()).filter(Boolean).map(Number);

  if (!prs.length) {
    console.log("No Dependabot merges need an AVRS record.");
    return;
  }

  // UTC date: ci_gate.py rejects a future authorizedAt, and the runner is UTC.
  const today = new Date().toISOString().slice(0, 10);
  const api = ghApi(repo);
  let failed = false;
  for (const n of prs) {
    const built = await rules.buildBackfillRecord({ api, prNumber: n, allowlist, today });
    if (!built.ok) {
      console.error(`CANNOT RECORD #${n}: ${built.reason}`);
      failed = true;
      continue;
    }
    const check = await rules.verifyBackfillRecord({ api, record: built.record, allowlist });
    if (!check.ok) {
      console.error(`RECORD FOR #${n} FAILED SELF-CHECK: ${check.reason}`);
      failed = true;
      continue;
    }
    const file = path.join(rules.RECORD_DIR, `${today}-dependabot-pr-${n}.json`);
    if (a.dryRun) {
      console.log(`[dry-run] ${file}\n${JSON.stringify(built.record, null, 2)}`);
    } else {
      fs.mkdirSync(path.join(root, rules.RECORD_DIR), { recursive: true });
      fs.writeFileSync(path.join(root, file), JSON.stringify(built.record, null, 2) + "\n");
      console.log(`wrote ${file}`);
    }
  }
  if (failed) {
    console.error("Some Dependabot merges could not be recorded. The gate will block PRs until they are; tell Justin.");
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e && e.stack ? e.stack : String(e));
  process.exit(1);
});
