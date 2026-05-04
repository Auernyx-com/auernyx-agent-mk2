import * as crypto from "crypto";

/**
 * Deterministic JSON serialization: sorts keys deeply, skips undefined values,
 * throws on circular references. All hash-producing code in this codebase must
 * use this function so that identical inputs always produce identical hashes.
 */
export function stableStringify(value: unknown): string {
    const seen = new WeakSet<object>();
    const normalize = (v: unknown): unknown => {
        if (v === null || v === undefined) return v;
        if (typeof v === "number" || typeof v === "boolean" || typeof v === "string") return v;
        if (Array.isArray(v)) return v.map(normalize);
        if (typeof v === "object") {
            if (seen.has(v as object)) throw new Error("circular_json");
            seen.add(v as object);
            const out: Record<string, unknown> = {};
            for (const k of Object.keys(v as object).sort()) {
                const val = (v as Record<string, unknown>)[k];
                if (val !== undefined) out[k] = normalize(val);
            }
            return out;
        }
        return v;
    };
    return JSON.stringify(normalize(value));
}

export function sha256Hex(value: Buffer | string): string {
    return crypto.createHash("sha256").update(value).digest("hex");
}
