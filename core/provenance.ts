import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { sha256Hex, stableStringify } from "./crypto";
import { buildSealedCopy, parseSealedCopy, SEALED_FILE_REFS, type SealedCopy, type SealedFileRaw } from "./sealedCopy";

export type ProvenanceFailureCode =
    | "genesis_missing"
    | "genesis_deleted"
    | "genesis_parse_error"
    | "genesis_hash_mismatch"
    | "governance_hash_mismatch"
    | "project_id_mismatch"
    | "seal_chain_broken";

// Damage to the seal itself, as opposed to a change to the sealed config.
// Both are re-sealable with approval (Justin, 2026-11-27); damage re-seals
// start a new anchor and check the approver against the last surviving
// sealed copy.
export const SEAL_DAMAGE_CODES: ReadonlySet<ProvenanceFailureCode> = new Set([
    "genesis_deleted",
    "genesis_parse_error",
    "genesis_hash_mismatch",
    "seal_chain_broken",
]);

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

// One human-approved re-seal (2026-11-27). Append-only: .auernyx/provenance/
// seals/000001.json, 000002.json, ... genesis.json is never rewritten. Each
// record is chained to the one before it (genesis for seal 1). An anchor
// record is a re-seal after damage to the seal itself: verification restarts
// there, and it pins the genesis file as it was when the human approved
// (sha256 of its bytes, or null when it was gone). restoration_proof and
// hitl_approval follow the same field layout as the canon judgment schema
// (governance/canon-adjacent/schemas/aesir.governance.judgment.v1.json).
export type SealRecord = {
    version: 1;
    seq: number;
    created_at: string;
    project_id: string;
    governance_hash: string;
    files: { ref: string; present: boolean; sha256: string }[];
    // governance.approverIdentity in the config this seal accepted: the
    // person who must approve the next re-seal.
    approver_identity: string;
    previous_record_hash: string | null;
    failure: { code: ProvenanceFailureCode; reason: string };
    anchor?: { genesis_sha256: string | null };
    // The sealed copy written with this seal, pinned by sha256.
    restoration_proof: { ref: string; sha256: string };
    hitl_approval: { approval_id: string; approved_by: { actor_id: string }; approved_at: string; reason: string };
    record_hash: string;
};

function provenanceDir(repoRoot: string): string {
    return path.join(repoRoot, ".auernyx", "provenance");
}

export function genesisPath(repoRoot: string): string {
    return path.join(provenanceDir(repoRoot), "genesis.json");
}

function sealsDir(repoRoot: string): string {
    return path.join(provenanceDir(repoRoot), "seals");
}

function sealedCopiesDir(repoRoot: string): string {
    return path.join(provenanceDir(repoRoot), "sealed");
}

function seqFileName(seq: number): string {
    return `${String(seq).padStart(6, "0")}.json`;
}

export function sealRecordPath(repoRoot: string, seq: number): string {
    return path.join(sealsDir(repoRoot), seqFileName(seq));
}

export function sealedCopyPath(repoRoot: string, seq: number): string {
    return path.join(sealedCopiesDir(repoRoot), seqFileName(seq));
}

function sealedCopyRef(seq: number): string {
    return `.auernyx/provenance/sealed/${seqFileName(seq)}`;
}

// Sequence numbers of the NNNNNN.json files in a directory, ascending.
// Other file names are ignored.
function seqFilesIn(dir: string): number[] {
    if (!fs.existsSync(dir)) return [];
    return fs
        .readdirSync(dir)
        .filter((n) => /^\d{6}\.json$/.test(n))
        .map((n) => Number(n.slice(0, 6)))
        .sort((a, b) => a - b);
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

// 2026-11-27 (Justin): Obsidian's Judgment must fail closed if genesis is
// deleted without prior authorization. A missing genesis used to look exactly
// like an uninitialized repo, so the next write-enabled run re-created it,
// sealing whatever the config said at that moment, and Judgment cleared
// itself. Evidence that this install was already sealed; any one is enough.
// Never the mere existence of the provenance audit log or judgment file:
// read-only runs write those without ever sealing. Only written after a
// write-enabled run has sealed genesis, and none of these paths are tracked
// in git, so a fresh clone has none of them.
export function priorSealEvidence(repoRoot: string): string[] {
    const evidence: string[] = [];

    const audit = readFileIfExists(auditPath(repoRoot)) ?? "";
    const sealedBefore = audit.includes("genesis.created") && audit.split("\n").some((line) => {
        try {
            return JSON.parse(line)?.kind === "genesis.created";
        } catch {
            return false;
        }
    });
    if (sealedBefore) evidence.push("provenance_audit:genesis.created");

    try {
        const records = path.join(repoRoot, ".auernyx", "kintsugi", "ledger", "records");
        if (fs.existsSync(records) && fs.readdirSync(records).length > 0) evidence.push("kintsugi_ledger_records");
    } catch {
        evidence.push("kintsugi_ledger_records_unreadable");
    }

    try {
        const ledger = path.join(repoRoot, "logs", "ledger.ndjson");
        if (fs.existsSync(ledger) && fs.statSync(ledger).size > 0) evidence.push("audit_ledger_entries");
    } catch {
        evidence.push("audit_ledger_unreadable");
    }

    // Re-seal records and sealed copies are only ever written on a sealed
    // install (2026-11-27).
    try {
        if (seqFilesIn(sealsDir(repoRoot)).length > 0) evidence.push("seal_records");
    } catch {
        evidence.push("seal_records_unreadable");
    }
    try {
        if (seqFilesIn(sealedCopiesDir(repoRoot)).length > 0) evidence.push("sealed_copies");
    } catch {
        evidence.push("sealed_copies_unreadable");
    }

    return evidence;
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

function readSealedFiles(repoRoot: string): SealedFileRaw[] {
    return SEALED_FILE_REFS.map((ref) => ({ ref, raw: readFileIfExists(path.join(repoRoot, ...ref.split("/"))) }));
}

// The governance hash formula is unchanged (every existing seal depends on
// it): sha256 over the raw text of the two sealed files.
function governanceHashOf(files: SealedFileRaw[]): string {
    const raw = (ref: string) => files.find((f) => f.ref === ref)?.raw ?? "";
    return sha256Hex(stableStringify({ allowlist: raw("config/allowlist.json"), auernyx_config: raw("config/auernyx.config.json") }));
}

function computeGovernanceHash(repoRoot: string): string {
    return governanceHashOf(readSealedFiles(repoRoot));
}

function computeSealRecordHash(record: Omit<SealRecord, "record_hash"> | SealRecord): string {
    return sha256Hex(stableStringify({ ...record, record_hash: undefined }));
}

type ChainEntry = { seq: number; record?: SealRecord; problem?: string };

function readSealChain(repoRoot: string): ChainEntry[] {
    return seqFilesIn(sealsDir(repoRoot)).map((seq): ChainEntry => {
        try {
            const parsed = JSON.parse(fs.readFileSync(sealRecordPath(repoRoot, seq), "utf8"));
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { seq, problem: "not a JSON object" };
            return { seq, record: parsed as SealRecord };
        } catch {
            return { seq, problem: "unreadable or not JSON" };
        }
    });
}

function sealRecordIntact(entry: ChainEntry): boolean {
    const r = entry.record;
    if (!r || r.version !== 1 || r.seq !== entry.seq) return false;
    if (typeof r.governance_hash !== "string" || typeof r.project_id !== "string" || typeof r.record_hash !== "string") return false;
    return computeSealRecordHash(r) === r.record_hash;
}

function genesisFileSha256(repoRoot: string): string | null {
    const p = genesisPath(repoRoot);
    if (!fs.existsSync(p)) return null;
    return sha256Hex(fs.readFileSync(p));
}

type GenesisState =
    | { state: "missing" }
    | { state: "unreadable"; error: string }
    | { state: "present"; record: GenesisRecord };

function readGenesisState(repoRoot: string): GenesisState {
    const p = genesisPath(repoRoot);
    if (!fs.existsSync(p)) return { state: "missing" };
    try {
        const parsed = JSON.parse(fs.readFileSync(p, "utf8"));
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { state: "unreadable", error: "not a JSON object" };
        return { state: "present", record: parsed as GenesisRecord };
    } catch (e) {
        return { state: "unreadable", error: e instanceof Error ? e.message : String(e) };
    }
}

function genesisComputedHash(record: GenesisRecord): string {
    const base: Omit<GenesisRecord, "record_hash"> = {
        version: record.version,
        author_identity: record.author_identity,
        project_id: record.project_id,
        created_at: record.created_at,
        initial_governance_hash: record.initial_governance_hash,
    };
    return computeGenesisRecordHash(base);
}

function genesisIntact(record: GenesisRecord): boolean {
    const recorded = String(record.record_hash ?? "");
    return recorded !== "" && recorded === genesisComputedHash(record);
}

// The seal currently in force: genesis, or the newest seal record.
type SealHead = {
    seq: number;
    source: "genesis" | "seal";
    created_at: string;
    project_id: string;
    governance_hash: string;
    record_hash: string;
    approver_identity?: string;
    restoration_sha256?: string;
};

type ProvenanceFailure = Extract<ProvenanceStatus, { ok: false }>;

function failure(code: ProvenanceFailureCode, reason: string, details?: Record<string, unknown>): ProvenanceFailure {
    return { ok: false, code, reason, ...(details ? { details } : {}) };
}

function headFromSeal(r: SealRecord): SealHead {
    return {
        seq: r.seq,
        source: "seal",
        created_at: r.created_at,
        project_id: r.project_id,
        governance_hash: r.governance_hash,
        record_hash: r.record_hash,
        approver_identity: r.approver_identity,
        restoration_sha256: r.restoration_proof?.sha256,
    };
}

// Verify the seal chain and return the seal in force. Verification starts at
// the newest intact anchor (damage a human approved re-sealing), or at
// genesis when there is none; records before an anchor are history.
function walkSealChain(repoRoot: string): { ok: true; head: SealHead } | { ok: false; status: ProvenanceFailure } {
    const chain = readSealChain(repoRoot);
    let start = -1;
    for (let i = chain.length - 1; i >= 0; i--) {
        if (chain[i].record?.anchor && sealRecordIntact(chain[i])) {
            start = i;
            break;
        }
    }

    let head: SealHead;
    if (start === -1) {
        const g = readGenesisState(repoRoot);
        if (g.state === "missing") {
            const evidence = priorSealEvidence(repoRoot);
            if (evidence.length > 0) {
                return {
                    ok: false,
                    status: failure(
                        "genesis_deleted",
                        "Genesis record deleted after this install was sealed; it is not re-created without an authorized re-seal",
                        { expected_path: genesisPath(repoRoot), evidence }
                    ),
                };
            }
            return { ok: false, status: failure("genesis_missing", "Genesis record missing", { expected_path: genesisPath(repoRoot) }) };
        }
        if (g.state === "unreadable") {
            return { ok: false, status: failure("genesis_parse_error", "Genesis record unreadable", { error: g.error }) };
        }
        if (!genesisIntact(g.record)) {
            return {
                ok: false,
                status: failure("genesis_hash_mismatch", "Genesis record hash mismatch", {
                    recorded: String(g.record.record_hash ?? ""),
                    computed: genesisComputedHash(g.record),
                }),
            };
        }
        head = {
            seq: 0,
            source: "genesis",
            created_at: g.record.created_at,
            project_id: String(g.record.project_id ?? ""),
            governance_hash: String(g.record.initial_governance_hash ?? ""),
            record_hash: g.record.record_hash,
        };
    } else {
        const anchor = chain[start].record as SealRecord;
        const pinned = anchor.anchor?.genesis_sha256 ?? null;
        const observed = genesisFileSha256(repoRoot);
        if (pinned !== observed) {
            if (observed === null) {
                return {
                    ok: false,
                    status: failure("genesis_deleted", "Genesis file deleted after an approved re-seal pinned it", { pinned_by_seal: anchor.seq }),
                };
            }
            return {
                ok: false,
                status: failure("genesis_hash_mismatch", "Genesis file changed after an approved re-seal pinned it", {
                    pinned_by_seal: anchor.seq,
                    recorded: pinned,
                    observed,
                }),
            };
        }
        head = headFromSeal(anchor);
    }

    for (let i = start + 1; i < chain.length; i++) {
        const entry = chain[i];
        if (!entry.record) {
            return { ok: false, status: failure("seal_chain_broken", `Seal ${entry.seq} is ${entry.problem}`, { seq: entry.seq }) };
        }
        if (entry.seq !== head.seq + 1) {
            return {
                ok: false,
                status: failure("seal_chain_broken", `Seal ${head.seq + 1} is missing (next seal found: ${entry.seq})`, { seq: head.seq + 1 }),
            };
        }
        if (!sealRecordIntact(entry)) {
            return { ok: false, status: failure("seal_chain_broken", `Seal ${entry.seq} does not match its record hash`, { seq: entry.seq }) };
        }
        if (entry.record.previous_record_hash !== head.record_hash) {
            return {
                ok: false,
                status: failure("seal_chain_broken", `Seal ${entry.seq} is not chained to seal ${head.seq}`, { seq: entry.seq }),
            };
        }
        head = headFromSeal(entry.record);
    }

    // A sealed copy is written right after its seal record, so a copy newer
    // than the newest seal means a seal record was deleted.
    const copies = seqFilesIn(sealedCopiesDir(repoRoot));
    const newestCopy = copies.length ? copies[copies.length - 1] : -1;
    if (newestCopy > head.seq) {
        return {
            ok: false,
            status: failure("seal_chain_broken", `Sealed copy ${newestCopy} exists but seal ${newestCopy} is missing`, { seq: newestCopy }),
        };
    }

    return { ok: true, head };
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

    // Already sealed once: a missing genesis is a deletion, not a fresh start.
    // Never re-seal silently; Judgment stays active (verifyProvenance reports
    // genesis_deleted) until a human-authorized re-seal.
    const evidence = priorSealEvidence(repoRoot);
    if (evidence.length > 0) {
        // Not logged when an approved anchor already accepted the missing
        // genesis (the chain verifies), so a healthy install doesn't log a
        // refusal on every write-enabled run.
        if (!walkSealChain(repoRoot).ok) {
            appendProvenanceAudit(repoRoot, { kind: "genesis.recreate_refused", data: { evidence } });
        }
        return { created: false };
    }

    try {
        ensureDir(path.dirname(p));

        const author = String(process.env.AUERNYX_AUTHOR_IDENTITY ?? os.userInfo().username ?? "unknown").trim() || "unknown";
        const projectId = packageProjectId(repoRoot);
        const createdAt = new Date().toISOString();
        const files = readSealedFiles(repoRoot);
        const govHash = governanceHashOf(files);

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
        // Sealed copy 0: what genesis sealed, from the same bytes it hashed.
        writeSealedCopy(repoRoot, 0, createdAt, govHash, files);
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
    try {
        const walk = walkSealChain(repoRoot);
        if (!walk.ok) return walk.status;
        const head = walk.head;
        const sealedBy = head.source === "seal" ? { sealed_by: head.seq } : {};

        const observedProjectId = packageProjectId(repoRoot);
        if (head.project_id !== observedProjectId) {
            return failure("project_id_mismatch", "Project identifier mismatch", {
                declared: head.project_id,
                observed: observedProjectId,
                ...sealedBy,
            });
        }

        const observedGovHash = computeGovernanceHash(repoRoot);
        if (head.governance_hash !== observedGovHash) {
            return failure("governance_hash_mismatch", "Governance hash mismatch", {
                declared: head.governance_hash,
                observed: observedGovHash,
                ...sealedBy,
            });
        }

        return { ok: true };
    } catch (e) {
        return failure("genesis_parse_error", "Provenance records invalid", { error: e instanceof Error ? e.message : String(e) });
    }
}

// ─── Sealed copies and re-seals (2026-11-27) ────────────────────────────────

// An approved damage re-seal can accept a missing genesis: its anchor pins
// genesis as absent. Feneris uses this so it doesn't keep flagging an absence
// a human already approved (and recorded).
export function genesisAbsenceApproved(repoRoot: string): boolean {
    if (fs.existsSync(genesisPath(repoRoot))) return false;
    const chain = readSealChain(repoRoot);
    for (let i = chain.length - 1; i >= 0; i--) {
        if (chain[i].record?.anchor && sealRecordIntact(chain[i])) {
            return chain[i].record?.anchor?.genesis_sha256 === null;
        }
    }
    return false;
}

function writeSealedCopy(
    repoRoot: string,
    seq: number,
    createdAt: string,
    governanceHash: string,
    files: SealedFileRaw[]
): { written: boolean; sha256?: string } {
    try {
        const text = JSON.stringify(buildSealedCopy(seq, createdAt, governanceHash, files), null, 2) + "\n";
        ensureDir(sealedCopiesDir(repoRoot));
        fs.writeFileSync(sealedCopyPath(repoRoot, seq), text, { encoding: "utf8", flag: "wx" });
        return { written: true, sha256: sha256Hex(text) };
    } catch (e) {
        appendProvenanceAudit(repoRoot, { kind: "sealed_copy.write_failed", data: { seq, error: e instanceof Error ? e.message : String(e) } });
        return { written: false };
    }
}

// Seals made before sealed copies existed (or whose copy was lost) get their
// copy written the next time the config provably matches the seal: writes
// on, provenance passing. Same timestamp as the seal, so the bytes match a
// seal record's restoration_proof. Nothing is approved or loosened: the
// governance hash already proves this is the sealed content.
export function recordSealedCopyIfMissing(repoRoot: string, options?: { writeEnabled?: boolean }): { written: boolean } {
    const writeEnabled = options?.writeEnabled ?? (process.env.AUERNYX_WRITE_ENABLED === "1");
    if (!writeEnabled) return { written: false };
    try {
        if (!verifyProvenance(repoRoot).ok) return { written: false };
        const walk = walkSealChain(repoRoot);
        if (!walk.ok) return { written: false };
        const head = walk.head;
        if (fs.existsSync(sealedCopyPath(repoRoot, head.seq))) return { written: false };
        const files = readSealedFiles(repoRoot);
        const govHash = governanceHashOf(files);
        if (govHash !== head.governance_hash) return { written: false };
        const result = writeSealedCopy(repoRoot, head.seq, head.created_at, govHash, files);
        if (result.written) appendProvenanceAudit(repoRoot, { kind: "sealed_copy.restored", data: { seq: head.seq } });
        return { written: result.written };
    } catch {
        return { written: false };
    }
}

function readSealedCopyFile(repoRoot: string, seq: number): { copy: SealedCopy; sha256: string } | null {
    try {
        const p = sealedCopyPath(repoRoot, seq);
        if (!fs.existsSync(p)) return null;
        const raw = fs.readFileSync(p, "utf8");
        const copy = parseSealedCopy(raw);
        if (!copy || copy.seq !== seq) return null;
        return { copy, sha256: sha256Hex(raw) };
    } catch {
        return null;
    }
}

// The sealed copy that belongs to the seal in force, checked against it.
function sealedCopyForHead(repoRoot: string, head: SealHead): SealedCopy | null {
    const found = readSealedCopyFile(repoRoot, head.seq);
    if (!found || found.copy.governance_hash !== head.governance_hash) return null;
    if (head.source === "seal" && found.sha256 !== head.restoration_sha256) return null;
    return found.copy;
}

// Seal damage: the newest sealed copy that still checks out. A copy whose own
// seal record (or genesis) is still intact must match it; a copy whose seal
// is gone or damaged is the best surviving evidence and is taken as it is.
function lastSurvivingSealedCopy(repoRoot: string): { seq: number; copy: SealedCopy } | null {
    const seqs = seqFilesIn(sealedCopiesDir(repoRoot)).reverse();
    const chain = readSealChain(repoRoot);
    for (const seq of seqs) {
        const found = readSealedCopyFile(repoRoot, seq);
        if (!found) continue;
        if (seq === 0) {
            const g = readGenesisState(repoRoot);
            if (g.state === "present" && genesisIntact(g.record) && g.record.initial_governance_hash !== found.copy.governance_hash) continue;
        } else {
            const entry = chain.find((e) => e.seq === seq);
            if (entry && sealRecordIntact(entry) && entry.record?.restoration_proof?.sha256 !== found.sha256) continue;
        }
        return { seq, copy: found.copy };
    }
    return null;
}

export type ResealPlan =
    | { state: "intact" }
    | { state: "not_sealed"; failure: ProvenanceFailure }
    | {
          state: "needs_reseal";
          mode: "config_change" | "seal_damage";
          failure: ProvenanceFailure;
          // The governance hash of the config as it is now: what an approval
          // must name, so the state reviewed is the state sealed.
          governanceHash: string;
          // The governance hash of the seal being replaced, when known.
          sealedGovernanceHash: string | null;
          files: SealedFileRaw[];
          approver: { identity: string | null; source: string | null };
          sealedCopy: { seq: number; copy: SealedCopy } | null;
      };

export function planReseal(repoRoot: string): ResealPlan {
    const status = verifyProvenance(repoRoot);
    if (status.ok) return { state: "intact" };
    if (status.code === "genesis_missing") return { state: "not_sealed", failure: status };

    const files = readSealedFiles(repoRoot);
    const governanceHash = governanceHashOf(files);
    const damage = SEAL_DAMAGE_CODES.has(status.code);

    let approver: { identity: string | null; source: string | null } = { identity: null, source: null };
    let sealedCopy: { seq: number; copy: SealedCopy } | null = null;
    let sealedGovernanceHash: string | null = null;

    if (!damage) {
        const walk = walkSealChain(repoRoot);
        if (walk.ok) {
            const head = walk.head;
            sealedGovernanceHash = head.governance_hash;
            const copy = sealedCopyForHead(repoRoot, head);
            if (copy) sealedCopy = { seq: head.seq, copy };
            const named = head.source === "seal" ? head.approver_identity ?? "" : copy?.approver_identity ?? "";
            if (head.source === "seal" || copy) {
                approver = {
                    identity: named.trim() || null,
                    source: head.source === "seal" ? `seal ${head.seq}` : `sealed copy ${head.seq}`,
                };
            }
        }
    } else {
        sealedCopy = lastSurvivingSealedCopy(repoRoot);
        if (sealedCopy) {
            sealedGovernanceHash = sealedCopy.copy.governance_hash;
            approver = { identity: sealedCopy.copy.approver_identity.trim() || null, source: `sealed copy ${sealedCopy.seq}` };
        }
    }

    return {
        state: "needs_reseal",
        mode: damage ? "seal_damage" : "config_change",
        failure: status,
        governanceHash,
        sealedGovernanceHash,
        files,
        approver,
        sealedCopy,
    };
}

export type ResealApproval = { approval_id: string; actor_id: string; approved_at: string; reason: string };

// Write one approved re-seal: the seal record (the commit point), then its
// sealed copy. The caller has already checked the approval, the approver,
// the audit ledger and the self-test. Refuses if the config changed since
// the approval named it. Damage re-seals are anchors.
export function appendSealRecord(
    repoRoot: string,
    params: { failure: ProvenanceFailure; anchor: boolean; expectedGovernanceHash: string; approval: ResealApproval }
): { ok: true; record: SealRecord } | { ok: false; error: "PREVIEW_STALE" | "CHAIN_NOT_INTACT" | "RESEAL_WRITE_FAILED"; detail?: string } {
    const files = readSealedFiles(repoRoot);
    const governanceHash = governanceHashOf(files);
    if (governanceHash !== params.expectedGovernanceHash) return { ok: false, error: "PREVIEW_STALE" };

    let seq: number;
    let previous: string | null = null;
    if (params.anchor) {
        const sealSeqs = seqFilesIn(sealsDir(repoRoot));
        const copySeqs = seqFilesIn(sealedCopiesDir(repoRoot));
        seq = Math.max(0, ...sealSeqs, ...copySeqs) + 1;
    } else {
        const walk = walkSealChain(repoRoot);
        if (!walk.ok) return { ok: false, error: "CHAIN_NOT_INTACT", detail: walk.status.code };
        seq = walk.head.seq + 1;
        previous = walk.head.record_hash;
    }

    try {
        const createdAt = new Date().toISOString();
        const copy = buildSealedCopy(seq, createdAt, governanceHash, files);
        const copyText = JSON.stringify(copy, null, 2) + "\n";
        const base: Omit<SealRecord, "record_hash"> = {
            version: 1,
            seq,
            created_at: createdAt,
            project_id: packageProjectId(repoRoot),
            governance_hash: governanceHash,
            files: files.map((f) => ({ ref: f.ref, present: f.raw !== undefined, sha256: sha256Hex(f.raw ?? "") })),
            approver_identity: copy.approver_identity,
            previous_record_hash: previous,
            failure: { code: params.failure.code, reason: params.failure.reason },
            ...(params.anchor ? { anchor: { genesis_sha256: genesisFileSha256(repoRoot) } } : {}),
            restoration_proof: { ref: sealedCopyRef(seq), sha256: sha256Hex(copyText) },
            hitl_approval: {
                approval_id: params.approval.approval_id,
                approved_by: { actor_id: params.approval.actor_id },
                approved_at: params.approval.approved_at,
                reason: params.approval.reason,
            },
        };
        const record: SealRecord = { ...base, record_hash: computeSealRecordHash(base) };

        ensureDir(sealsDir(repoRoot));
        fs.writeFileSync(sealRecordPath(repoRoot, seq), JSON.stringify(record, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
        try {
            ensureDir(sealedCopiesDir(repoRoot));
            fs.writeFileSync(sealedCopyPath(repoRoot, seq), copyText, { encoding: "utf8", flag: "wx" });
        } catch (e) {
            // The seal stands without its copy; recordSealedCopyIfMissing
            // writes it back (byte-identical) on the next passing run.
            appendProvenanceAudit(repoRoot, { kind: "sealed_copy.write_failed", data: { seq, error: e instanceof Error ? e.message : String(e) } });
        }
        appendProvenanceAudit(repoRoot, {
            kind: "seal.created",
            data: {
                seq,
                anchor: params.anchor,
                failure: params.failure.code,
                governance_hash: governanceHash,
                approved_by: params.approval.actor_id,
            },
        });
        return { ok: true, record };
    } catch (e) {
        appendProvenanceAudit(repoRoot, { kind: "seal.create_failed", data: { seq, error: e instanceof Error ? e.message : String(e) } });
        return { ok: false, error: "RESEAL_WRITE_FAILED", detail: e instanceof Error ? e.message : String(e) };
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
