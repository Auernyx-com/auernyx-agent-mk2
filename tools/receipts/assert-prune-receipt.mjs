import { readFileSync } from "node:fs";

const approvalsPath = process.argv[2] || ".mk2/prune-approvals.json";
const branch = process.argv[3];

if (!branch) {
  console.error("Usage: node tools/receipts/assert-prune-receipt.mjs <approvals.json> <branch>");
  process.exit(2);
}

let approvals;
try {
  approvals = JSON.parse(readFileSync(approvalsPath, "utf8"));
} catch {
  console.error(`Missing or invalid approvals file: ${approvalsPath}`);
  process.exit(1);
}

const ok = Array.isArray(approvals?.approved) && approvals.approved.includes(branch);
if (!ok) {
  console.error(`No prune receipt approval found for branch: ${branch}`);
  process.exit(1);
}

console.log(`Prune receipt approval verified for: ${branch}`);
