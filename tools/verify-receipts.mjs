// Re-check every governance receipt's fingerprint (receipt_hash_sha256).
//
// Usage: npm run compile && npm run verify:receipts [-- <receipts dir>]
// Default dir: .auernyx/receipts (each run writes <runId>/governance.json).
//
// Fail-closed: exits 1 on any MISMATCH, MALFORMED, UNKNOWN_VERSION or
// unreadable receipt. LEGACY_UNVERSIONED receipts (written before
// receipt_hash_version 2, 2026-11-10) used a non-uniform formula that can't be
// re-derived from the receipt alone; they are counted and listed, not failed.

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { verifyReceiptHash } = require(path.join(process.cwd(), "dist", "core", "receiptHash.js"));

const dir = path.resolve(process.argv[2] ?? path.join(".auernyx", "receipts"));
if (!fs.existsSync(dir)) {
    console.log(`No receipts directory at ${dir}; nothing to verify.`);
    process.exit(0);
}

const files = [];
const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name === "governance.json") files.push(p);
    }
};
walk(dir);

const counts = { VALID: 0, LEGACY_UNVERSIONED: 0, MISMATCH: 0, MALFORMED: 0, UNKNOWN_VERSION: 0, UNREADABLE: 0 };
for (const f of files.sort()) {
    let result;
    try {
        result = verifyReceiptHash(JSON.parse(fs.readFileSync(f, "utf8")));
    } catch (e) {
        result = { status: "UNREADABLE", reason: e.message };
    }
    counts[result.status]++;
    if (result.status !== "VALID") {
        const detail = result.status === "MISMATCH" ? ` expected=${result.expected} actual=${result.actual}`
            : result.reason ? ` ${result.reason}` : result.version !== undefined ? ` version=${result.version}` : "";
        console.log(`${result.status.padEnd(18)} ${path.relative(process.cwd(), f)}${detail}`);
    }
}

console.log(`\n${files.length} receipt(s): ` + Object.entries(counts).filter(([, n]) => n).map(([k, n]) => `${k}=${n}`).join(" "));
const bad = counts.MISMATCH + counts.MALFORMED + counts.UNKNOWN_VERSION + counts.UNREADABLE;
if (bad) {
    console.error(`${bad} receipt(s) failed verification.`);
    process.exit(1);
}
