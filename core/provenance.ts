import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { sha256Hex, stableStringify } from "./crypto";

export type ProvenanceFailureCode =
    | "genesis_missing"
    | "genesis_parse_error"
    | "genesis_hash_mismatch"
    | "governance_hash_mismatch"
    | "project_id_mismatch";

export type ProvenanceStatus =
    | { ok: true }
    | {
          ok: false;
          code: ProvenanceFailureCode;
          reason: string;
          details?: Record<string, unknown>;
      };

export type GenesisRecord = {
    version: 1;
    author_identity: string;
    project_id: string;
    created_at: string;
    initial_governance_hash: string;
    record_hash: string;
};

export type JudgmentRecord = {
    active: true;
    activated_at: string;
    failure: Omit<Extract<ProvenanceStatus, { ok: false }>, "ok">;
};


function provenanceDir(repoRoot: string): string {
    return path.join(repoRoot, ".auernyx", "provenance");
}

export function genesisPath(repoRoot: string): string {
    return path.join(provenanceDir(repoRoot), "genesis.json");
}

export function judgmentPath(repoRoot: string): string {
    return path.join(provenanceDir(repoRoot), "judgment.json");
}

function auditPath(repoRoot: string): string {
    return path.join(provenanceDir(repoRoot), "audit.ndjson");
}

function ensureDir(p: string) {
    if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function readFileIfExists(p: string): string | undefined {
    try {
        if (!fs.existsSync(p)) return undefined;
        return fs.readFileSync(p, "utf8");
    } catch {
        return undefined;
    }
}

function packageProjectId(repoRoot: string): string {
    try {
        const pkgPath = path.join(repoRoot, "package.json");
        const raw = fs.readFileSync(pkgPath, "utf8");
        const parsed = JSON.parse(raw) as any;
        const name = typeof parsed?.name === "string" ? parsed.name.trim() : "";
        return name || path.basename(path.resolve(repoRoot));
    } catch {
        return path.basename(path.resolve(repoRoot));
    }
}

function computeGovernanceHash(repoRoot: string): string {
    const allowlist = readFileIfExists(path.join(repoRoot, "config", "allowlist.json")) ?? "";
    const cfg = readFileIfExists(path.join(repoRoot, "config", "auernyx.config.json")) ?? "";
    return sha256Hex(stableStringify({ allowlist, auernyx_config: cfg }));
}

function computeGenesisRecordHash(payload: Omit<GenesisRecord, "record_hash">): string {
    return sha256Hex(stableStringify({ ...payload, record_hash: undefined }));
}

export function appendProvenanceAudit(repoRoot: string, event: { kind: string; data?: unknown }) {
    try {
        const dir = provenanceDir(repoRoot);
        ensureDir(dir);
        const entry = { ts: new Date().toISOString(), ...event };
        fs.appendFileSync(auditPath(repoRoot), JSON.stringify(entry) + "\n", "utf8");
    } catch {
        // ignore
    }
}

export function ensureGenesisRecord(repoRoot: string, options?: { writeEnabled?: boolean }): { created: boolean } {
    const writeEnabled = options?.writeEnabled ?? (process.env.AUERNYX_WRITE_ENABLED === "1");
    const p = genesisPath(repoRoot);

    if (fs.existsSync(p)) return { created: false };
    if (!writeEnabled) return { created: false };

    try {
        ensureDir(path.dirname(p));

        const author = String(process.env.AUERNYX_AUTHOR_IDENTITY ?? os.userInfo().username ?? "unknown").trim() || "unknown";
        const projectId = packageProjectId(repoRoot);
        const createdAt = new Date().toISOString();
        const govHash = computeGovernanceHash(repoRoot);

        const base: Omit<GenesisRecord, "record_hash"> = {
            version: 1,
            author_identity: author,
            project_id: projectId,
            created_at: createdAt,
            initial_governance_hash: govHash,
        };

        const record: GenesisRecord = {
            ...base,
            record_hash: computeGenesisRecordHash(base),
        };

        fs.writeFileSync(p, JSON.stringify(record, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
        appendProvenanceAudit(repoRoot, { kind: "genesis.created", data: { project_id: projectId } });
        return { created: true };
    } catch (e) {
        appendProvenanceAudit(repoRoot, { kind: "genesis.create_failed", data: { error: e instanceof Error ? e.message : String(e) } });
        return { created: false };
    }
}

export function readGenesisRecord(repoRoot: string): GenesisRecord | null {
    const p = genesisPath(repoRoot);
    try {
        if (!fs.existsSync(p)) return null;
        const raw = fs.readFileSync(p, "utf8");
        return JSON.parse(raw) as GenesisRecord;
    } catch {
        return null;
    }
}

export function verifyProvenance(repoRoot: string): ProvenanceStatus {
    const observedProjectId = packageProjectId(repoRoot);

    const genesisRaw = readGenesisRecord(repoRoot);
    if (!genesisRaw) {
        return {
            ok: false,
            code: "genesis_missing",
            reason: "Genesis record missing",
            details: { expected_path: genesisPath(repoRoot) },
        };
    }

    try {
        const base: Omit<GenesisRecord, "record_hash"> = {
            version: genesisRaw.version,
            author_identity: genesisRaw.author_identity,
            project_id: genesisRaw.project_id,
            created_at: genesisRaw.created_at,
            initial_governance_hash: genesisRaw.initial_governance_hash,
        };

        const computed = computeGenesisRecordHash(base);
        const recorded = String(genesisRaw.record_hash ?? "");
        if (!recorded || recorded !== computed) {
            return {
                ok: false,
                code: "genesis_hash_mismatch",
                reason: "Genesis record hash mismatch",
                details: { recorded, computed },
            };
        }

        if (String(genesisRaw.project_id ?? "") !== observedProjectId) {
            return {
                ok: false,
                code: "project_id_mismatch",
                reason: "Project identifier mismatch",
                details: { declared: genesisRaw.project_id, observed: observedProjectId },
            };
        }

        const observedGovHash = computeGovernanceHash(repoRoot);
        if (String(genesisRaw.initial_governance_hash ?? "") !== observedGovHash) {
            return {
                ok: false,
                code: "governance_hash_mismatch",
                reason: "Governance hash mismatch",
                details: { declared: genesisRaw.initial_governance_hash, observed: observedGovHash },
            };
        }

        return { ok: true };
    } catch (e) {
        return {
            ok: false,
            code: "genesis_parse_error",
            reason: "Genesis record invalid",
            details: { error: e instanceof Error ? e.message : String(e) },
        };
    }
}

export function readJudgment(repoRoot: string): JudgmentRecord | null {
    const p = judgmentPath(repoRoot);
    try {
        if (!fs.existsSync(p)) return null;
        return JSON.parse(fs.readFileSync(p, "utf8")) as JudgmentRecord;
    } catch {
        return null;
    }
}

export function isJudgmentActive(repoRoot: string): boolean {
    const j = readJudgment(repoRoot);
    return Boolean(j?.active);
}

export function activateJudgment(repoRoot: string, failure: Extract<ProvenanceStatus, { ok: false }>) {
    try {
        const dir = provenanceDir(repoRoot);
        ensureDir(dir);
        const record: JudgmentRecord = {
            active: true,
            activated_at: new Date().toISOString(),
            failure: { code: failure.code, reason: failure.reason, details: failure.details },
        };
        fs.writeFileSync(judgmentPath(repoRoot), JSON.stringify(record, null, 2) + "\n", "utf8");
        appendProvenanceAudit(repoRoot, { kind: "judgment.activated", data: record.failure });
    } catch {
        // ignore
    }
}

export function clearJudgment(repoRoot: string) {
    try {
        const p = judgmentPath(repoRoot);
        if (fs.existsSync(p)) fs.unlinkSync(p);
        appendProvenanceAudit(repoRoot, { kind: "judgment.cleared" });
    } catch {
        // ignore
    }
}
