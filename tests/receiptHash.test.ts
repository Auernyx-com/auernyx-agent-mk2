import assert from "node:assert/strict";
import test from "node:test";
import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";
import { computeReceiptHash, verifyReceiptHash, RECEIPT_HASH_VERSION } from "../core/receiptHash";
import { runLifecycle } from "../core/runLifecycle";
import { createRouter } from "../core/router";
import { createPolicy } from "../core/policy";

// Found 2026-11-10 while wiring the Kotlin parity check: receipt_hash_sha256
// was written inline at 12 sites in runLifecycle.ts with no shared formula and
// no verifier. One refusal path ordered message before plan/diff, OK receipts
// left the message out, and the applied path hashed a changed-file list that
// isn't stored in the receipt. Nothing ever recomputed it. These tests pin the
// single formula (same as the Kotlin verifier) and prove real receipts verify.

const sha = (s: string) => crypto.createHash("sha256").update(s, "utf8").digest("hex");

function v2(fields: { decision_code: string; plan: string; diff: string; message: string }) {
    return {
        decision_code: fields.decision_code,
        plan_hash_sha256: fields.plan,
        diff_hash_sha256: fields.diff,
        message: fields.message,
        receipt_hash_sha256: computeReceiptHash(fields.decision_code, fields.plan, fields.diff, fields.message),
        receipt_hash_version: RECEIPT_HASH_VERSION,
    };
}

test("formula is PREFIX:code:plan:diff:message, same as the Kotlin verifier", () => {
    assert.equal(computeReceiptHash("OK_APPLIED", "p", "d", "m"), sha("OK:OK_APPLIED:p:d:m"));
    assert.equal(computeReceiptHash("OK_PREVIEW_ONLY", "p", "d", ""), sha("OK:OK_PREVIEW_ONLY:p:d:"));
    assert.equal(computeReceiptHash("REFUSE_PROTECTED_PATH", "p", "d", "m"), sha("REFUSED:REFUSE_PROTECTED_PATH:p:d:m"));
    // pre-plan refusals: empty plan/diff are hashed as empty, not skipped
    assert.equal(computeReceiptHash("REFUSE_AMBIGUOUS_REQUEST", "", "", "m"), sha("REFUSED:REFUSE_AMBIGUOUS_REQUEST:::m"));
});

test("a well-formed v2 receipt verifies", () => {
    assert.deepEqual(verifyReceiptHash(v2({ decision_code: "OK_APPLIED", plan: "a", diff: "b", message: "c" })), { status: "VALID" });
});

test("editing any hashed field after the fact is caught", () => {
    const base = v2({ decision_code: "REFUSE_WRITE_GATE_MISSING", plan: "a", diff: "b", message: "approval_required" });
    for (const [k, val] of [
        ["decision_code", "OK_APPLIED"],
        ["plan_hash_sha256", "x"],
        ["diff_hash_sha256", "x"],
        ["message", "approved"],
        ["receipt_hash_sha256", "0".repeat(64)],
    ] as const) {
        const r = verifyReceiptHash({ ...base, [k]: val });
        assert.equal(r.status, "MISMATCH", `editing ${k} should be detected`);
    }
});

test("legacy, unknown-version and malformed receipts are never reported VALID", () => {
    const { receipt_hash_version: _drop, ...legacy } = v2({ decision_code: "OK_APPLIED", plan: "a", diff: "b", message: "c" });
    assert.equal(verifyReceiptHash(legacy).status, "LEGACY_UNVERSIONED");
    assert.equal(verifyReceiptHash({ ...legacy, receipt_hash_version: 99 }).status, "UNKNOWN_VERSION");
    assert.equal(verifyReceiptHash({ receipt_hash_version: RECEIPT_HASH_VERSION, decision_code: "OK_APPLIED" }).status, "MALFORMED");
    assert.equal(verifyReceiptHash(null).status, "MALFORMED");
    assert.equal(verifyReceiptHash([]).status, "MALFORMED");
});

// ---- Real receipts written by runLifecycle --------------------------------

function makeRepoRoot(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mk2-receipthash-test-"));
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "test" }));
    fs.mkdirSync(path.join(dir, "config"), { recursive: true });
    fs.writeFileSync(
        path.join(dir, "config", "allowlist.json"),
        JSON.stringify({ allowedCapabilities: ["searchDocPreview", "searchDocApply"] })
    );
    fs.writeFileSync(
        path.join(dir, "config", "auernyx.config.json"),
        JSON.stringify({ governance: { approverIdentity: "Test Approver" }, writeEnabled: true, receiptsEnabled: true })
    );
    fs.writeFileSync(path.join(dir, ".gitignore"), ".canon/\nvar/canon/\n.auernyx/\nlogs/\n");
    execFileSync("git", ["init", "-q"], { cwd: dir });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
    execFileSync("git", ["add", "-A"], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "initial"], { cwd: dir });
    return dir;
}

function governanceReceipts(repoRoot: string): Array<{ file: string; json: any }> {
    const out: Array<{ file: string; json: any }> = [];
    const walk = (d: string) => {
        if (!fs.existsSync(d)) return;
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            const p = path.join(d, e.name);
            if (e.isDirectory()) walk(p);
            else if (e.name === "governance.json") out.push({ file: p, json: JSON.parse(fs.readFileSync(p, "utf8")) });
        }
    };
    walk(path.join(repoRoot, ".auernyx", "receipts"));
    return out;
}

const approval = { approvedBy: "human" as const, at: new Date().toISOString(), reason: "test", identity: "Test Approver" };

test("every governance receipt runLifecycle writes (applied, preview, refusal) verifies", async () => {
    const repoRoot = makeRepoRoot();
    const router = createRouter(createPolicy(repoRoot), {
        searchDocPreview: async () => ({ mode: "preview" }),
        searchDocApply: async () => ({ mode: "applied" }),
    } as any);
    const ctx = { repoRoot, sessionId: "test-session" } as any;
    const input = { action: "add", docPath: "docs/x.md", title: "X" };

    // applied
    await runLifecycle({
        router, ctx, intent: "search doc apply", input, executeStepId: "step-2",
        stepApprovals: [{ ...approval, stepId: "step-2", apply: true, confirm: "APPLY", acknowledgedRollbackPointIds: ["rb-1"] }],
    } as any);
    // armed approval missing -> preview-only or refusal, depending on path
    await runLifecycle({ router, ctx, intent: "search doc apply", input, executeStepId: "step-2", stepApprovals: [] } as any);
    // full plan, approval for step-1 only -> refusal for step-2
    await runLifecycle({
        router, ctx, intent: "search doc apply", input,
        stepApprovals: [{ ...approval, stepId: "step-1", apply: true, confirm: "APPLY", acknowledgedRollbackPointIds: ["rb-1"] }],
    } as any);

    const receipts = governanceReceipts(repoRoot);
    assert.ok(receipts.length >= 3, `expected at least 3 governance receipts, found ${receipts.length}`);
    const codes = new Set<string>();
    for (const { file, json } of receipts) {
        codes.add(json.decision_code);
        assert.equal(json.receipt_hash_version, RECEIPT_HASH_VERSION, `${file} missing receipt_hash_version`);
        assert.deepEqual(verifyReceiptHash(json), { status: "VALID" }, `${file} (${json.decision_code}) did not verify`);
    }
    assert.ok([...codes].some((c) => c.startsWith("OK_")), `no OK receipt exercised: ${[...codes]}`);
    assert.ok([...codes].some((c) => c.startsWith("REFUSE_")), `no refusal receipt exercised: ${[...codes]}`);
});
