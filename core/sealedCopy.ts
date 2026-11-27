// Sealed copies of the governance config (2026-11-27, provenance re-seal).
//
// Every seal (genesis, and every approved re-seal) keeps a local copy of what
// it sealed: config/allowlist.json and config/auernyx.config.json, flattened
// to key paths. Two jobs:
//   1. The re-seal preview shows a real diff ("daemon.port: 43117 -> 43118")
//      instead of only "the governance hash changed".
//   2. It names the approver from the SEALED config, not the edited one, so
//      nobody can put their own name in the config and approve themselves.
// Secret-looking values (daemon.secret, API keys, tokens) are never stored:
// the copy keeps a salted hash, so a change still shows as "[redacted]
// changed" without the value. The copy lives under .auernyx/ (not in git).

import { createHash } from "crypto";
import { stableStringify } from "./crypto";

export const SEALED_FILE_REFS = ["config/allowlist.json", "config/auernyx.config.json"] as const;
export const CONFIG_REF = "config/auernyx.config.json";
export const REDACTED = "[redacted]";

const SECRET_KEY_PATTERN = /secret|token|password|passphrase|api[-_]?key|private[-_]?key|credential/i;

export type SealedFileRaw = { ref: string; raw: string | undefined };

export type SealedFileCopy = {
    ref: string;
    present: boolean;
    // sha256 of the raw file text ("" when the file is absent).
    sha256: string;
    // false when the file is absent or not valid JSON.
    json: boolean;
    // Flattened key path -> value. Secret-looking values are "[redacted]".
    values: Record<string, unknown> | null;
    // Key path -> salted sha256 of the secret value. Local only, never shown.
    redacted: Record<string, string>;
};

export type SealedCopy = {
    version: 1;
    seq: number;
    created_at: string;
    governance_hash: string;
    // governance.approverIdentity in the sealed config ("" when none).
    approver_identity: string;
    files: SealedFileCopy[];
};

export type KeyChange = {
    path: string;
    change: "added" | "removed" | "changed";
    from?: unknown;
    to?: unknown;
    added?: unknown[];
    removed?: unknown[];
    note?: string;
};

export type FileChange = {
    file: string;
    status: "unchanged" | "changed" | "added" | "removed" | "formatting_only" | "unknown";
    keys?: KeyChange[];
    note?: string;
};

function sha256(text: string): string {
    return createHash("sha256").update(text, "utf8").digest("hex");
}

function isPrimitive(v: unknown): boolean {
    return v === null || ["string", "number", "boolean"].includes(typeof v);
}

function isSecretPath(keyPath: string): boolean {
    const last = keyPath.replace(/\[\d+\]/g, "").split(".").pop() ?? "";
    return SECRET_KEY_PATTERN.test(last);
}

function isEmptySecret(v: unknown): boolean {
    return v === null || v === "";
}

// Objects become dotted key paths. Arrays of plain values stay whole (shown as
// added/removed items); arrays holding objects get [index] paths.
export function flattenJson(value: unknown, prefix = "", out: Record<string, unknown> = {}): Record<string, unknown> {
    if (Array.isArray(value)) {
        if (value.every(isPrimitive)) {
            out[prefix] = value;
        } else {
            value.forEach((v, i) => flattenJson(v, `${prefix}[${i}]`, out));
        }
        return out;
    }
    if (value !== null && typeof value === "object") {
        const keys = Object.keys(value as object);
        if (keys.length === 0 && prefix) {
            out[prefix] = {};
            return out;
        }
        for (const k of keys) flattenJson((value as Record<string, unknown>)[k], prefix ? `${prefix}.${k}` : k, out);
        return out;
    }
    out[prefix] = value;
    return out;
}

function secretToken(salt: string, value: unknown): string {
    return sha256(`${salt}:${JSON.stringify(value)}`);
}

function readApprover(parsed: unknown): string {
    const v = (parsed as any)?.governance?.approverIdentity;
    return typeof v === "string" ? v.trim() : "";
}

// Deterministic for the same files, seq, timestamp and governance hash, so a
// copy written back later is byte-identical to the original (a seal record
// pins its copy by sha256).
export function buildSealedCopy(seq: number, createdAt: string, governanceHash: string, files: SealedFileRaw[]): SealedCopy {
    let approver = "";
    const out = files.map((f): SealedFileCopy => {
        const present = f.raw !== undefined;
        const base = { ref: f.ref, present, sha256: sha256(f.raw ?? "") };
        if (!present) return { ...base, json: false, values: null, redacted: {} };
        let parsed: unknown;
        try {
            parsed = JSON.parse(f.raw as string);
        } catch {
            return { ...base, json: false, values: null, redacted: {} };
        }
        if (f.ref === CONFIG_REF) approver = readApprover(parsed);
        const values: Record<string, unknown> = {};
        const redacted: Record<string, string> = {};
        for (const [k, v] of Object.entries(flattenJson(parsed))) {
            if (isSecretPath(k) && !isEmptySecret(v)) {
                values[k] = REDACTED;
                redacted[k] = secretToken(governanceHash, v);
            } else {
                values[k] = v;
            }
        }
        return { ...base, json: true, values, redacted };
    });
    return { version: 1, seq, created_at: createdAt, governance_hash: governanceHash, approver_identity: approver, files: out };
}

export function parseSealedCopy(raw: string): SealedCopy | null {
    try {
        const c = JSON.parse(raw);
        if (!c || typeof c !== "object" || c.version !== 1) return null;
        if (typeof c.seq !== "number" || typeof c.governance_hash !== "string" || typeof c.approver_identity !== "string") return null;
        if (!Array.isArray(c.files)) return null;
        return c as SealedCopy;
    } catch {
        return null;
    }
}

type Token = { key: string; show: unknown };

function sealedToken(file: SealedFileCopy, keyPath: string): Token {
    if (keyPath in file.redacted) return { key: `secret:${file.redacted[keyPath]}`, show: REDACTED };
    return { key: `plain:${stableStringify(file.values?.[keyPath])}`, show: file.values?.[keyPath] };
}

function currentToken(salt: string, keyPath: string, value: unknown): Token {
    if (isSecretPath(keyPath) && !isEmptySecret(value)) return { key: `secret:${secretToken(salt, value)}`, show: REDACTED };
    return { key: `plain:${stableStringify(value)}`, show: value };
}

function diffValues(sealed: SealedFileCopy, now: Record<string, unknown>, salt: string): KeyChange[] {
    const was = sealed.values ?? {};
    const out: KeyChange[] = [];
    const paths = [...new Set([...Object.keys(was), ...Object.keys(now)])].sort();
    for (const p of paths) {
        const inWas = p in was;
        const inNow = p in now;
        if (inWas && !inNow) {
            out.push({ path: p, change: "removed", from: sealedToken(sealed, p).show });
            continue;
        }
        const after = currentToken(salt, p, now[p]);
        if (!inWas) {
            out.push({ path: p, change: "added", to: after.show });
            continue;
        }
        const before = sealedToken(sealed, p);
        if (before.key === after.key) continue;

        if (Array.isArray(before.show) && Array.isArray(after.show)) {
            const has = (list: unknown[], v: unknown) => list.some((x) => stableStringify(x) === stableStringify(v));
            const added = after.show.filter((v) => !has(before.show as unknown[], v));
            const removed = (before.show as unknown[]).filter((v) => !has(after.show as unknown[], v));
            const change: KeyChange = { path: p, change: "changed", added, removed };
            if (added.length === 0 && removed.length === 0) change.note = "order changed only";
            out.push(change);
            continue;
        }
        out.push({ path: p, change: "changed", from: before.show, to: after.show });
    }
    return out;
}

// What changed in each sealed file since the copy was taken.
export function describeChanges(copy: SealedCopy | null, files: SealedFileRaw[]): FileChange[] {
    return files.map((f): FileChange => {
        if (!copy) return { file: f.ref, status: "unknown", note: "No sealed copy to compare against" };
        const sealed = copy.files.find((x) => x.ref === f.ref);
        if (!sealed) return { file: f.ref, status: "unknown", note: "Not in the sealed copy" };

        const present = f.raw !== undefined;
        if (sealed.present === present && sealed.sha256 === sha256(f.raw ?? "")) return { file: f.ref, status: "unchanged" };
        if (sealed.present && !present) return { file: f.ref, status: "removed" };

        let parsed: unknown;
        try {
            parsed = JSON.parse(f.raw as string);
        } catch {
            return { file: f.ref, status: sealed.present ? "changed" : "added", note: "Not valid JSON now; no key-level diff" };
        }
        const now = flattenJson(parsed);
        if (!sealed.present) {
            const empty: SealedFileCopy = { ...sealed, values: {}, redacted: {} };
            return { file: f.ref, status: "added", keys: diffValues(empty, now, copy.governance_hash) };
        }
        if (!sealed.json || !sealed.values) {
            return { file: f.ref, status: "changed", note: "The sealed version was not valid JSON; no key-level diff" };
        }
        const keys = diffValues(sealed, now, copy.governance_hash);
        if (keys.length === 0) {
            return { file: f.ref, status: "formatting_only", note: "Only whitespace or key order changed; no values changed" };
        }
        return { file: f.ref, status: "changed", keys };
    });
}
