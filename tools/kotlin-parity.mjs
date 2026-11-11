// TypeScript <-> Kotlin parity check (fail-closed).
//
// branches/kotlin-consumer/ is the independent second implementation of the
// locked governance contract. Its own proof battery (npm run verify:kotlin)
// only tests Kotlin against itself; nothing ever checked that the TypeScript
// trunk and the Kotlin verifier still agree. Found 2026-11-10: verify:kotlin
// was in no workflow at all, last run by hand 2026-01-09.
//
// This script checks the parts that are meant to be identical:
//   1. The locked decision/refusal code set (core/runLifecycle.ts vs DecisionCodes.kt)
//   2. Every locked receipt field in Kotlin's GovernanceReceipt is still a field
//      the TypeScript receipt writes
//   3. Live: bytes hashed by TypeScript's sha256Hex (dist/core/crypto.js) are
//      accepted by the real Kotlin verifier, tampered bytes are refused, and the
//      write-gate matrix gives the expected locked codes
//   4. Live: Kotlin's plan_hash_sha256 (sha256 of the envelope text) equals
//      TypeScript's sha256Hex of the same text
//   5. Live: every receipt_hash_sha256 Kotlin writes equals TypeScript's
//      computeReceiptHash (core/receiptHash.ts) over the same receipt fields.
//      (Until 2026-11-10 the TS formula was non-uniform across 12 inline
//      sites; core/receiptHash.ts is now the single formula, matching Kotlin.)
//
// Requires: npm run compile (for dist/), Java 17, and the Kotlin app built with
//   (cd branches/kotlin-consumer && ./gradlew installDist)

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const repoRoot = process.cwd();
const kotlinRoot = path.join(repoRoot, "branches", "kotlin-consumer");
const require = createRequire(import.meta.url);

let failures = 0;
const pass = (msg) => console.log(`PASS  ${msg}`);
const fail = (msg) => { failures++; console.error(`FAIL  ${msg}`); };
const read = (p) => fs.readFileSync(path.join(repoRoot, p), "utf8");

// ---- 1. Locked code set ---------------------------------------------------
const kotlinCodesSrc = read("branches/kotlin-consumer/src/main/kotlin/ygg/DecisionCodes.kt");
const kotlinCodes = new Set([...kotlinCodesSrc.matchAll(/const val [A-Z_]+ = "([A-Z_]+)"/g)].map((m) => m[1]));

const lifecycleSrc = read("core/runLifecycle.ts");
const typeBlock = (name) => {
    const m = lifecycleSrc.match(new RegExp(`type ${name} =([^;]+);`));
    if (!m) { fail(`could not find 'type ${name}' in core/runLifecycle.ts`); return []; }
    return [...m[1].matchAll(/"([A-Z_]+)"/g)].map((x) => x[1]);
};
const tsCodes = new Set([...typeBlock("DecisionCode"), ...typeBlock("RefusalCode")]);

const onlyKotlin = [...kotlinCodes].filter((c) => !tsCodes.has(c));
const onlyTs = [...tsCodes].filter((c) => !kotlinCodes.has(c));
if (kotlinCodes.size === 0 || tsCodes.size === 0) {
    fail(`code set parse failed (kotlin=${kotlinCodes.size}, ts=${tsCodes.size})`);
} else if (onlyKotlin.length || onlyTs.length) {
    fail(`locked code sets differ. only in Kotlin: [${onlyKotlin}] only in TypeScript: [${onlyTs}]`);
} else {
    pass(`locked code sets identical (${tsCodes.size} codes)`);
}

// ---- 2. Locked receipt fields ---------------------------------------------
const receiptSrc = read("branches/kotlin-consumer/src/main/kotlin/ygg/Receipt.kt");
const classBody = receiptSrc.match(/data class GovernanceReceipt\(([\s\S]*?)\)\s*\{/);
const lockedFields = classBody ? [...classBody[1].matchAll(/val ([a-z0-9_]+)\s*:/g)].map((m) => m[1]) : [];
if (lockedFields.length === 0) {
    fail("could not parse GovernanceReceipt fields from Receipt.kt");
} else {
    const missing = lockedFields.filter((f) => !new RegExp(`\\b${f}\\s*:`).test(lifecycleSrc));
    if (missing.length) fail(`locked receipt fields missing from core/runLifecycle.ts: [${missing}]`);
    else pass(`all ${lockedFields.length} locked receipt fields present in TypeScript receipts`);
}

// ---- 3 & 4. Live cross-implementation run ---------------------------------
let tsSha256Hex, tsComputeReceiptHash;
try {
    ({ sha256Hex: tsSha256Hex } = require(path.join(repoRoot, "dist", "core", "crypto.js")));
    ({ computeReceiptHash: tsComputeReceiptHash } = require(path.join(repoRoot, "dist", "core", "receiptHash.js")));
} catch (e) {
    fail(`could not load dist/core (run npm run compile first): ${e.message}`);
}

const bin = path.join(kotlinRoot, "build", "install", "ygg-kotlin-consumer", "bin",
    process.platform === "win32" ? "ygg-kotlin-consumer.bat" : "ygg-kotlin-consumer");
if (!fs.existsSync(bin)) fail(`Kotlin app not built at ${bin} (run ./gradlew installDist in branches/kotlin-consumer)`);

if (tsSha256Hex && tsComputeReceiptHash && fs.existsSync(bin)) {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), "mk2-kotlin-parity-"));
    // Non-ASCII on purpose: proves both sides hash the same UTF-8 bytes.
    const payloadText = JSON.stringify({ intent: "parity", note: "Yggdrasil — ᚢ root/trunk/branch/leaf", n: 7 });
    const payloadPath = path.join(work, "payload.json");
    fs.writeFileSync(payloadPath, payloadText, "utf8");
    const goodDigest = tsSha256Hex(Buffer.from(payloadText, "utf8"));

    const runKotlin = (name, envelope, armed, envOn) => {
        const envelopePath = path.join(work, `${name}.envelope.json`);
        const envelopeText = typeof envelope === "string" ? envelope : JSON.stringify(envelope);
        fs.writeFileSync(envelopePath, envelopeText, "utf8");
        const receiptDir = path.join(work, name);
        const r = spawnSync(bin, ["--envelope", envelopePath, "--receipt-dir", receiptDir,
            "--armed", String(armed), "--env", String(envOn), "--repo-root", work], { encoding: "utf8" });
        if (r.status !== 0) {
            fail(`${name}: Kotlin exited ${r.status}: ${r.stderr || r.error}`);
            return null;
        }
        const receipt = JSON.parse(fs.readFileSync(path.join(receiptDir, "governance.json"), "utf8"));
        return { receipt, envelopeText };
    };

    const envelope = (digest, extra = {}) => ({
        canonical_payload_json_path: payloadPath,
        canonical_payload_digest: digest,
        canonical_event_id: "parity-evt-1",
        parser_version: "v1",
        ...extra,
    });

    const cases = [
        { name: "ts-digest-preview", env: envelope(goodDigest), armed: false, envOn: false, want: "OK_PREVIEW_ONLY" },
        { name: "ts-digest-armed-no-env", env: envelope(goodDigest), armed: true, envOn: false, want: "REFUSE_WRITE_GATE_MISSING" },
        { name: "ts-digest-armed-env", env: envelope(goodDigest), armed: true, envOn: true, want: "OK_APPLIED" },
        { name: "tampered-digest", env: envelope(tsSha256Hex("not the payload")), armed: true, envOn: true, want: "REFUSE_AUDIT_WEAKENING" },
        { name: "missing-field", env: { canonical_payload_digest: goodDigest, canonical_event_id: "x", parser_version: "v1" }, armed: false, envOn: false, want: "REFUSE_AMBIGUOUS_REQUEST" },
    ];

    for (const c of cases) {
        const out = runKotlin(c.name, c.env, c.armed, c.envOn);
        if (!out) continue;
        const got = out.receipt.decision_code;
        if (got !== c.want) fail(`${c.name}: Kotlin decided ${got}, expected ${c.want} (${out.receipt.message})`);
        else pass(`${c.name}: ${got}`);
        if (!tsCodes.has(got)) fail(`${c.name}: Kotlin emitted ${got}, which TypeScript does not recognise`);
        const tsPlanHash = tsSha256Hex(Buffer.from(out.envelopeText, "utf8"));
        if (out.receipt.plan_hash_sha256 !== tsPlanHash) {
            fail(`${c.name}: plan hash differs. Kotlin=${out.receipt.plan_hash_sha256} TypeScript=${tsPlanHash}`);
        }
        const r = out.receipt;
        const tsReceiptHash = tsComputeReceiptHash(r.decision_code, r.plan_hash_sha256, r.diff_hash_sha256, r.message);
        if (r.receipt_hash_sha256 !== tsReceiptHash) {
            fail(`${c.name}: receipt hash differs. Kotlin=${r.receipt_hash_sha256} TypeScript=${tsReceiptHash}`);
        }
    }
    if (failures === 0) {
        pass("plan_hash_sha256: Kotlin and TypeScript hash identical bytes identically");
        pass("receipt_hash_sha256: Kotlin and TypeScript use the identical receipt formula");
    }
    fs.rmSync(work, { recursive: true, force: true });
}

if (failures) {
    console.error(`\n${failures} parity failure(s). TypeScript and Kotlin disagree; do not merge until resolved.`);
    process.exit(1);
}
console.log("\nTypeScript <-> Kotlin parity: OK");
