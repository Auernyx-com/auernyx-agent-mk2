import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

export type LedgerIntegrityResult = {
    ok: boolean;
    warnings: string[];
    checkedEntries: number;
    lastHash?: string;
    // Independent-audit finding (2026-09-08, round 10, medium): when the
    // ledger has more lines than maxEntries, only the last maxEntries are
    // ever read -- the hash-chain linkage check is explicitly skipped for
    // the first entry of that slice ("we can't validate linkage unless it's
    // the first ever"), and that entry's own prevHash can be anything,
    // including nothing at all. Confirmed directly with a probe: a ledger
    // whose entire prefix outside the window was a literally-invalid JSON
    // line plus a fabricated hash still reported ok:true, checkedEntries
    // equal to the window size, with zero indication the prefix was never
    // looked at. This field lets a security-critical caller (see
    // capabilities/governanceUnlock.ts) tell "verified from genesis" apart
    // from "verified this recent window only" and fail closed on the
    // latter, rather than treating a bounded, best-effort check the same
    // as a real end-to-end guarantee.
    truncated: boolean;
};

function stableStringify(value: unknown): string {
    return JSON.stringify(value, (_key, val) => {
        if (val && typeof val === "object" && !Array.isArray(val)) {
            return Object.keys(val as Record<string, unknown>)
                .sort()
                .reduce<Record<string, unknown>>((acc, k) => {
                    acc[k] = (val as Record<string, unknown>)[k];
                    return acc;
                }, {});
        }
        return val;
    });
}

export function sha256Hex(text: string): string {
    return crypto.createHash("sha256").update(text).digest("hex");
}

export function sha256FileHex(filePath: string): string {
    const buf = fs.readFileSync(filePath);
    return crypto.createHash("sha256").update(buf).digest("hex");
}

function readLinesSafe(filePath: string): string[] {
    if (!fs.existsSync(filePath)) return [];
    const raw = fs.readFileSync(filePath, "utf8");
    return raw
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
}

export function verifyLedgerIntegrity(repoRoot: string, options?: { maxEntries?: number }): LedgerIntegrityResult {
    const ledgerPath = path.join(repoRoot, "logs", "ledger.ndjson");
    const maxEntries = Math.max(1, Math.min(options?.maxEntries ?? 10_000, 200_000));

    const warnings: string[] = [];
    const lines = readLinesSafe(ledgerPath);
    const truncated = lines.length > maxEntries;
    const slice = truncated ? lines.slice(lines.length - maxEntries) : lines;
    if (truncated) {
        warnings.push(
            `Ledger has ${lines.length} entries, only the last ${maxEntries} were checked -- ` +
            `linkage to genesis was NOT verified.`
        );
    }

    let prevHash: string | undefined;
    let checked = 0;

    for (const line of slice) {
        checked++;
        let parsed: any;
        try {
            parsed = JSON.parse(line);
        } catch {
            warnings.push("Ledger contains non-JSON line.");
            return { ok: false, warnings, checkedEntries: checked, truncated };
        }

        const { ts, sessionId, event, data, prevHash: entryPrevHash, hash } = parsed ?? {};
        if (typeof hash !== "string" || !hash) {
            warnings.push("Ledger entry missing hash.");
            return { ok: false, warnings, checkedEntries: checked, truncated };
        }

        if (checked === 1) {
            // For the first entry in our slice, we can’t validate linkage unless it’s the first ever.
            // We only enforce linkage for subsequent entries.
        } else {
            if (entryPrevHash !== prevHash) {
                warnings.push("Ledger chain prevHash mismatch.");
                return { ok: false, warnings, checkedEntries: checked, lastHash: prevHash, truncated };
            }
        }

        const toHash = stableStringify({ ts, sessionId, event, data, prevHash: entryPrevHash });
        const computed = sha256Hex(toHash);
        if (computed !== hash) {
            warnings.push("Ledger entry hash mismatch.");
            return { ok: false, warnings, checkedEntries: checked, lastHash: prevHash, truncated };
        }

        prevHash = hash;
    }

    return { ok: true, warnings, checkedEntries: checked, lastHash: prevHash, truncated };
}
