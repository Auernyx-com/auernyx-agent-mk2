import { sha256Hex } from "./crypto";

/**
 * Governance receipt fingerprint (receipt_hash_sha256), the single source of
 * truth for every governance.json runLifecycle writes.
 *
 * Formula (identical to the independent Kotlin verifier,
 * branches/kotlin-consumer GovernanceReceipt.computeReceiptHash):
 *
 *     sha256( PREFIX ":" decision_code ":" plan_hash_sha256 ":" diff_hash_sha256 ":" message )
 *     PREFIX = "OK" when decision_code starts with "OK_", else "REFUSED"
 *
 * Every input is a field stored in the same receipt, so any receipt can be
 * re-checked from the receipt alone (verifyReceiptHash). Refusals that happen
 * before a plan exists store plan/diff hashes as "" and hash them as "".
 *
 * History: v1 (2026-01-05 to 2026-11-10) was written inline at 12 sites with
 * no shared helper and no verifier. It was not uniform: one refusal path put
 * the message before plan/diff, OK receipts left the message out, the applied
 * path hashed the changed-file list (which is not stored in the receipt, so it
 * could never be re-checked), and pre-plan refusals skipped plan/diff. Nothing
 * ever recomputed the hash, so nothing broke, but nothing was protected either.
 * v1 receipts carry no receipt_hash_version and are reported as LEGACY.
 */
export const RECEIPT_HASH_VERSION = 2;

export function computeReceiptHash(
    decisionCode: string,
    planHashSha256: string,
    diffHashSha256: string,
    message: string
): string {
    const prefix = decisionCode.startsWith("OK_") ? "OK" : "REFUSED";
    return sha256Hex(`${prefix}:${decisionCode}:${planHashSha256}:${diffHashSha256}:${message}`);
}

export type ReceiptHashCheck =
    | { status: "VALID" }
    | { status: "MISMATCH"; expected: string; actual: string }
    | { status: "LEGACY_UNVERSIONED" }
    | { status: "UNKNOWN_VERSION"; version: unknown }
    | { status: "MALFORMED"; reason: string };

/**
 * Re-derive receipt_hash_sha256 from a governance receipt's own fields and
 * compare. Fail-closed: anything that is not a well-formed v2 receipt whose
 * hash matches is reported as something other than VALID.
 */
export function verifyReceiptHash(receipt: unknown): ReceiptHashCheck {
    if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) {
        return { status: "MALFORMED", reason: "receipt is not a JSON object" };
    }
    const r = receipt as Record<string, unknown>;
    if (!("receipt_hash_version" in r)) return { status: "LEGACY_UNVERSIONED" };
    if (r.receipt_hash_version !== RECEIPT_HASH_VERSION) {
        return { status: "UNKNOWN_VERSION", version: r.receipt_hash_version };
    }
    for (const k of ["decision_code", "plan_hash_sha256", "diff_hash_sha256", "message", "receipt_hash_sha256"]) {
        if (typeof r[k] !== "string") return { status: "MALFORMED", reason: `${k} missing or not a string` };
    }
    const expected = computeReceiptHash(
        r.decision_code as string,
        r.plan_hash_sha256 as string,
        r.diff_hash_sha256 as string,
        r.message as string
    );
    const actual = r.receipt_hash_sha256 as string;
    return expected === actual ? { status: "VALID" } : { status: "MISMATCH", expected, actual };
}
