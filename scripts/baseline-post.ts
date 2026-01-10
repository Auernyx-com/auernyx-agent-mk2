// Baseline post-check script for Mk2
// Usage: node scripts/baseline-post.ts

import fs from "fs";
import path from "path";
import crypto from "crypto";

function hashFile(filePath: string): string {
  const data = fs.readFileSync(filePath);
  return crypto.createHash("sha256").update(data).digest("hex");
}

function hashDir(dirPath: string): string {
  const files = fs.readdirSync(dirPath).filter(f => f.endsWith(".json"));
  const hashes = files.map(f => hashFile(path.join(dirPath, f)));
  return crypto.createHash("sha256").update(hashes.join("")).digest("hex");
}

function main() {
  const ledgerFile = path.join(process.cwd(), ".mk2", "ledger", "events.ndjson");
  const receiptsDir = path.join(process.cwd(), ".mk2", "receipts");

  if (!fs.existsSync(ledgerFile)) {
    console.error("Ledger file missing:", ledgerFile);
    process.exit(1);
  }
  if (!fs.existsSync(receiptsDir)) {
    console.error("Receipts directory missing:", receiptsDir);
    process.exit(2);
  }

  const ledgerHash = hashFile(ledgerFile);
  const receiptsHash = hashDir(receiptsDir);

  console.log("Ledger SHA-256:", ledgerHash);
  console.log("Receipts SHA-256:", receiptsHash);

  // Write signed summary file
  const summary = {
    timestamp: new Date().toISOString(),
    ledgerHash,
    receiptsHash,
  };
  const summaryPath = path.join(process.cwd(), ".mk2", "summary.json");
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2), "utf8");
  console.log("Summary written to:", summaryPath);
}

main();
