import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { createHash, randomUUID } from "crypto";
import { REASONS_VERSION, type RefusalReasonCode } from "./reasons";
import { loadConfig } from "../config";

export type FailureType = "logic" | "data" | "execution" | "governance";
export type RecoveryAction = "none" | "retry" | "override" | "rollback" | "compensate";
export type FailureSeverity = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export type MandatoryFailureRecord = {
    failure_id: string;
    timestamp: string;
    system: string;
    failure_type: FailureType;
    trigger: string;
    inputs_snapshot: string;
    pre_state: string;
    post_state: string;
    recovery_action: RecoveryAction;
    authorized_by: string;
    notes?: string;
};

export type MandatoryRefusalRecord = {
    refusal_id: string;
    timestamp: string;
    system: string;
    requested_action: string;
    refusal_reason: RefusalReasonCode;
    reasons_version: number;
    policy_refs: string[];
    risk_level: FailureSeverity;
    what_would_be_required: string;
    notes?: string;
};

export type KintsugiRecord = MandatoryFailureRecord & {
    severity?: FailureSeverity;
    normalized_error_code?: string;
    signature?: string;

    record_kind?: "MFR";

    prev_hash?: string;
    record_hash?: string;

    policy_before_hash?: string;
    policy_after_hash?: string;
    change_set?: Record<string, { from: unknown; to: unknown }>;
    approved_by?: string;
    approval_timestamp?: string;
    risk_level?: "SAFE" | "CONTROLLED";
    blast_radius?: string[];

    baseline_snapshot_path?: string;
    baseline_snapshot_hash?: string;
};

export type KintsugiRefusalRecord = MandatoryRefusalRecord & {
    record_kind: "MRR";

    prev_hash?: string;
    record_hash?: string;

    normalized_error_code?: string;
    signature?: string;
};

export type KintsugiLedgerRecord = KintsugiRecord | KintsugiRefusalRecord;

const KINTSUGI_DIR = path.join(".auernyx", "kintsugi");
const LEDGER_RECORDS_DIR = path.join(KINTSUGI_DIR, "ledger", "records");
const POLICY_DIR = path.join(KINTSUGI_DIR, "policy");
const POLICY_HISTORY_DIR = path.join(POLICY_DIR, "history");
const ACTIVE_POLICY_FILE = path.join(POLICY_DIR, "active.policy.json");

export type KintsugiPolicy = {
    confirmArtifactWrites: boolean;
    strictPreflightForArtifactWrites: boolean;
    showKintsugiOutputOnFailure: boolean;
    driftDetectionEnabled: boolean;
    riskTolerance: "SAFE" | "CONTROLLED";
    approverIdentity?: string;

    allowRollback: boolean;
    rollbackWindowDays: number;
    rollbackMaxDepth: number;
    rollbackRequiresIntegrityPass: boolean;
    rollbackRiskClass: "SAFE" | "CONTROLLED";
};

const DEFAULT_POLICY: KintsugiPolicy = {
    confirmArtifactWrites: true,
    strictPreflightForArtifactWrites: false,
    showKintsugiOutputOnFailure: false,
    driftDetectionEnabled: true,
    riskTolerance: "SAFE",
    approverIdentity: undefined,

    allowRollback: true,
    rollbackWindowDays: 30,
    rollbackMaxDepth: 10,
    rollbackRequiresIntegrityPass: true,
    rollbackRiskClass: "CONTROLLED",
};

export function getKintsugiPolicy(repoRoot: string): KintsugiPolicy {
    try {
        const activePath = path.join(repoRoot, ACTIVE_POLICY_FILE);
        if (!fs.existsSync(activePath)) return { ...DEFAULT_POLICY };
        const parsed = JSON.parse(fs.readFileSync(activePath, { encoding: "utf8" })) as Partial<KintsugiPolicy>;
        return { ...DEFAULT_POLICY, ...parsed };
    } catch {
        return { ...DEFAULT_POLICY };
    }
}

export function policyHash(policy: KintsugiPolicy): string {
    return sha256Hex(stableStringify(policy));
}

export function makeSnapshotHash(input: unknown): string {
    const payload = typeof input === "string" ? input : stableStringify(input);
    return sha256Hex(payload);
}

export function makeMfr(params: Omit<MandatoryFailureRecord, "failure_id" | "timestamp">): MandatoryFailureRecord {
    return {
        failure_id: randomUUID(),
        timestamp: new Date().toISOString(),
        ...params,
    };
}

export function makeMrr(params: Omit<MandatoryRefusalRecord, "refusal_id" | "timestamp">): MandatoryRefusalRecord {
    return {
        refusal_id: randomUUID(),
        timestamp: new Date().toISOString(),
        ...params,
    };
}

export function getApproverIdentity(repoRoot: string): string {
    const cfg = loadConfig(repoRoot);
    const configured = String(cfg.governance.approverIdentity ?? "").trim();
    if (configured) return configured;

    const policy = getKintsugiPolicy(repoRoot);
    const policyIdentity = String(policy.approverIdentity ?? "").trim();
    if (policyIdentity) return policyIdentity;

    return os.userInfo().username;
}

export async function recordRefusal(
    repoRoot: string,
    params: Omit<MandatoryRefusalRecord, "refusal_id" | "timestamp" | "reasons_version"> & { notes?: string }
): Promise<KintsugiRefusalRecord> {
    await ensurePolicyInitialized(repoRoot);

    const base: MandatoryRefusalRecord = makeMrr({
        reasons_version: REASONS_VERSION,
        ...params,
    });

    const record: KintsugiRefusalRecord = {
        ...base,
        record_kind: "MRR",
        normalized_error_code: `REFUSAL_${base.refusal_reason}`,
        signature: `refusal::${base.system}::${base.requested_action}::${base.refusal_reason}`,
    };

    return (await recordLedger(repoRoot, record)) as KintsugiRefusalRecord;
}

export async function recordFailure(repoRoot: string, record: KintsugiRecord): Promise<KintsugiRecord> {
    await ensurePolicyInitialized(repoRoot);

    const normalized: KintsugiRecord = { record_kind: "MFR", ...record };
    return (await recordLedger(repoRoot, normalized)) as KintsugiRecord;
}

export async function recordHumanApprovedPolicyChange(
    repoRoot: string,
    params: {
        suggestionId: string;
        reason: string;
        before: KintsugiPolicy;
        after: KintsugiPolicy;
        riskLevel: "SAFE" | "CONTROLLED";
        blastRadius: string[];
    }
): Promise<void> {
    const approvedBy = getApproverIdentity(repoRoot);
    const approvalTimestamp = new Date().toISOString();

    const beforeHash = policyHash(params.before);
    const afterHash = policyHash(params.after);
    const changeSet = diffPolicy(params.before, params.after);

    await writePolicySnapshotAndActivate(repoRoot, params.after, {
        suggestionId: params.suggestionId,
        reason: params.reason,
        approvedBy,
        riskLevel: params.riskLevel,
        blastRadius: params.blastRadius,
    });

    await recordFailure(repoRoot, {
        ...makeMfr({
            system: "kintsugi:policy",
            failure_type: "governance",
            trigger: "Human-approved policy change",
            inputs_snapshot: makeSnapshotHash({
                suggestionId: params.suggestionId,
                reason: params.reason,
            }),
            pre_state: beforeHash,
            post_state: afterHash,
            recovery_action: "override",
            authorized_by: approvedBy,
            notes: "Policy changes are recorded to prevent silent correction.",
        }),
        severity: params.riskLevel === "CONTROLLED" ? "HIGH" : "MEDIUM",
        normalized_error_code: "POLICY_CHANGE",
        signature: `governance::kintsugi:policy::Human-approved policy change::POLICY_CHANGE`,
        policy_before_hash: beforeHash,
        policy_after_hash: afterHash,
        change_set: changeSet,
        approved_by: approvedBy,
        approval_timestamp: approvalTimestamp,
        risk_level: params.riskLevel,
        blast_radius: params.blastRadius,
    });
}

export async function verifyKintsugiIntegrity(
    repoRoot: string,
    options?: { initializePolicy?: boolean }
): Promise<{ ok: boolean; warnings: string[] }> {
    const envWriteEnabled = process.env.AUERNYX_WRITE_ENABLED === "1";
    const initializePolicy = options?.initializePolicy ?? envWriteEnabled;
    if (initializePolicy) {
        await ensurePolicyInitialized(repoRoot);
    }

    const records = await readFailures(repoRoot);
    const ledgerValidation = await validateLedgerChain(records);
    const policyValidation = await validatePolicySnapshots(repoRoot, records);
    return {
        ok: ledgerValidation.ok && policyValidation.ok,
        warnings: [...ledgerValidation.warnings, ...policyValidation.warnings],
    };
}

export async function readFailures(repoRoot: string): Promise<KintsugiLedgerRecord[]> {
    const recordsDir = path.join(repoRoot, LEDGER_RECORDS_DIR);
    // Combine existsSync with readdirSync error handling to avoid double filesystem check
    let files: string[];
    try {
        files = fs.readdirSync(recordsDir);
    } catch {
        return [];
    }
    
    // Filter and sort in one pass
    const jsonFiles = files.filter((f) => f.endsWith(".json")).sort();

    const out: KintsugiLedgerRecord[] = [];
    for (const file of jsonFiles) {
        try {
            const raw = fs.readFileSync(path.join(recordsDir, file), { encoding: "utf8" });
            out.push(JSON.parse(raw) as KintsugiLedgerRecord);
        } catch {
            // Append-only: do not delete/repair here.
        }
    }
    return out;
}

export async function getLastLedgerRecord(repoRoot: string): Promise<KintsugiLedgerRecord | undefined> {
    const recordsDir = path.join(repoRoot, LEDGER_RECORDS_DIR);
    let files: string[];
    try {
        files = fs.readdirSync(recordsDir);
    } catch {
        return undefined;
    }
    
    // Optimize: find max instead of full sort when only need last element
    let lastFile: string | undefined;
    for (const f of files) {
        if (f.endsWith(".json")) {
            if (!lastFile || f > lastFile) {
                lastFile = f;
            }
        }
    }
    
    if (!lastFile) return undefined;
    try {
        const raw = fs.readFileSync(path.join(recordsDir, lastFile), { encoding: "utf8" });
        return JSON.parse(raw) as KintsugiLedgerRecord;
    } catch {
        return undefined;
    }
}

export async function ledgerHasRecordHash(repoRoot: string, recordHash: string): Promise<boolean> {
    if (!recordHash) return false;
    const records = await readFailures(repoRoot);
    return records.some((r) => String((r as any).record_hash ?? "") === recordHash);
}

export async function snapshotPolicyAndActivate(
    repoRoot: string,
    policy: KintsugiPolicy,
    meta: {
        suggestionId: string;
        reason: string;
        approvedBy: string;
        riskLevel: "SAFE" | "CONTROLLED";
        blastRadius: string[];
    }
): Promise<{ snapshotPath: string; hash: string }> {
    await ensurePolicyInitialized(repoRoot);
    return writePolicySnapshotAndActivate(repoRoot, policy, meta);
}

async function recordLedger(repoRoot: string, record: KintsugiLedgerRecord): Promise<KintsugiLedgerRecord> {
    const base = path.join(repoRoot, LEDGER_RECORDS_DIR);
    fs.mkdirSync(base, { recursive: true });

    const prev = await getLastLedgerRecord(repoRoot);
    const prevHash = (prev as any)?.record_hash as string | undefined;

    const normalized = normalizeLedgerRecord(record);
    const withChain: KintsugiLedgerRecord = {
        ...(normalized as any),
        prev_hash: prevHash,
    };

    const recordHash = sha256Hex(stableStringify({ ...(withChain as any), record_hash: undefined }));
    (withChain as any).record_hash = recordHash;

    const id = ledgerRecordId(withChain);
    const fileName = `${fileTimestamp(String((withChain as any).timestamp))}_${id}.json`;
    const filePath = path.join(base, fileName);

    if (fs.existsSync(filePath)) {
        throw new Error(`Ledger collision: ${fileName}`);
    }

    fs.writeFileSync(filePath, stableStringify(withChain) + "\n", { encoding: "utf8", flag: "wx" });
    return withChain;
}

function sha256Hex(input: string): string {
    return createHash("sha256").update(input, "utf8").digest("hex");
}

function stableStringify(input: unknown): string {
    return JSON.stringify(sortKeysDeep(input));
}

function sortKeysDeep(input: unknown): unknown {
    if (Array.isArray(input)) return input.map(sortKeysDeep);
    if (input && typeof input === "object") {
        const obj = input as Record<string, unknown>;
        const out: Record<string, unknown> = {};
        // Optimize: get keys once and cache the sorted result
        const keys = Object.keys(obj);
        if (keys.length === 0) return out;
        keys.sort();
        for (const key of keys) {
            const value = obj[key];
            if (value === undefined) continue;
            out[key] = sortKeysDeep(value);
        }
        return out;
    }
    return input;
}

function fileTimestamp(iso: string): string {
    return iso.replace(/:/g, "").replace(/-/g, "").replace(".", "_");
}

function normalizeLedgerRecord(record: KintsugiLedgerRecord): KintsugiLedgerRecord {
    const normalizedError = (record as any).normalized_error_code?.trim() || undefined;

    if ((record as any).record_kind === "MRR") {
        const rr = record as KintsugiRefusalRecord;
        return {
            ...rr,
            reasons_version: (rr as any).reasons_version ?? 0,
            normalized_error_code: normalizedError ?? `REFUSAL_${rr.refusal_reason}`,
            signature:
                rr.signature?.trim() ||
                `refusal::${rr.system}::${rr.requested_action}::${rr.refusal_reason}`,
        };
    }

    const mfr = record as KintsugiRecord;
    const signature = mfr.signature?.trim() || makeSignature(mfr, normalizedError);
    return {
        ...mfr,
        record_kind: mfr.record_kind ?? "MFR",
        normalized_error_code: normalizedError,
        signature,
    };
}

function makeSignature(record: MandatoryFailureRecord, normalizedErrorCode?: string): string {
    return `${record.failure_type}::${record.system}::${record.trigger}::${normalizedErrorCode ?? "NONE"}`;
}

function ledgerRecordId(record: KintsugiLedgerRecord): string {
    if ((record as any).record_kind === "MRR") return String((record as any).refusal_id);
    return String((record as any).failure_id);
}

function diffPolicy(before: KintsugiPolicy, after: KintsugiPolicy): Record<string, { from: unknown; to: unknown }> {
    const out: Record<string, { from: unknown; to: unknown }> = {};
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const key of Array.from(keys).sort()) {
        const from = (before as any)[key];
        const to = (after as any)[key];
        if (stableStringify(from) !== stableStringify(to)) {
            out[key] = { from, to };
        }
    }
    return out;
}

async function ensurePolicyInitialized(repoRoot: string): Promise<void> {
    const activePath = path.join(repoRoot, ACTIVE_POLICY_FILE);
    if (fs.existsSync(activePath)) return;

    const approvedBy = "policy:kintsugi";
    await writePolicySnapshotAndActivate(repoRoot, { ...DEFAULT_POLICY }, {
        suggestionId: "policy-init",
        reason: "Initialize default Kintsugi policy",
        approvedBy,
        riskLevel: "SAFE",
        blastRadius: ["kintsugi-policy"],
    }).catch(() => undefined);
}

async function writePolicySnapshotAndActivate(
    repoRoot: string,
    policy: KintsugiPolicy,
    meta: {
        suggestionId: string;
        reason: string;
        approvedBy: string;
        riskLevel: "SAFE" | "CONTROLLED";
        blastRadius: string[];
    }
): Promise<{ snapshotPath: string; hash: string }> {
    const base = path.join(repoRoot, POLICY_DIR);
    const historyDir = path.join(repoRoot, POLICY_HISTORY_DIR);
    fs.mkdirSync(historyDir, { recursive: true });

    const hash = policyHash(policy);
    const stamp = fileTimestamp(new Date().toISOString());
    const snapName = `${stamp}_${randomUUID()}.policy.json`;
    const snapshotPath = path.join(historyDir, snapName);

    const snapshotPayload = {
        policy,
        policy_hash: hash,
        created_at: new Date().toISOString(),
        created_by: meta.approvedBy,
        reason: meta.reason,
        suggestion_id: meta.suggestionId,
        risk_level: meta.riskLevel,
        blast_radius: meta.blastRadius,
    };

    fs.writeFileSync(snapshotPath, stableStringify(snapshotPayload) + "\n", { encoding: "utf8", flag: "wx" });

    const activePath = path.join(repoRoot, ACTIVE_POLICY_FILE);
    const tmpPath = path.join(base, `active.policy.json.tmp_${randomUUID()}`);
    fs.mkdirSync(base, { recursive: true });
    fs.writeFileSync(tmpPath, stableStringify(policy) + "\n", { encoding: "utf8" });
    fs.renameSync(tmpPath, activePath);

    return { snapshotPath, hash };
}

async function validateLedgerChain(records: KintsugiLedgerRecord[]): Promise<{ ok: boolean; warnings: string[] }> {
    const warnings: string[] = [];
    if (!records.length) return { ok: true, warnings };

    let prevHash: string | undefined = undefined;
    let prevTime: number | undefined = undefined;

    for (const rec of records) {
        const computedHash = sha256Hex(stableStringify({ ...rec, record_hash: undefined }));
        if ((rec as any).record_hash !== computedHash) {
            warnings.push(`Ledger hash mismatch for ${ledgerRecordId(rec)}`);
        }
        if ((rec as any).prev_hash !== prevHash) {
            warnings.push(`Ledger prev_hash mismatch for ${ledgerRecordId(rec)}`);
        }

        const t = Date.parse((rec as any).timestamp);
        if (!Number.isFinite(t)) warnings.push(`Invalid timestamp for ${ledgerRecordId(rec)}`);
        if (prevTime !== undefined && Number.isFinite(t) && t < prevTime) {
            warnings.push(`Timestamp out of order at ${ledgerRecordId(rec)}`);
        }

        prevHash = (rec as any).record_hash;
        prevTime = Number.isFinite(t) ? t : prevTime;
    }

    return { ok: warnings.length === 0, warnings };
}

async function validatePolicySnapshots(
    repoRoot: string,
    records: KintsugiLedgerRecord[]
): Promise<{ ok: boolean; warnings: string[] }> {
    const warnings: string[] = [];

    const historyDir = path.join(repoRoot, POLICY_HISTORY_DIR);
    const snapshotHashes = new Map<string, string>();
    
    // Optimize: avoid existsSync, just try to read and catch error
    try {
        const files = fs.readdirSync(historyDir);
        const policyFiles = files.filter((f) => f.endsWith(".policy.json")).sort();
        
        for (const file of policyFiles) {
            const full = path.join(historyDir, file);
            try {
                const payload = JSON.parse(fs.readFileSync(full, { encoding: "utf8" })) as any;
                const computed = policyHash(payload.policy as KintsugiPolicy);
                const declared = String(payload.policy_hash ?? "");
                if (declared && declared !== computed) {
                    warnings.push(`Policy snapshot hash mismatch: ${file}`);
                }
                if (declared) snapshotHashes.set(declared, file);
            } catch {
                warnings.push(`Failed to parse policy snapshot: ${file}`);
            }
        }
    } catch {
        // Directory doesn't exist, skip
    }

    const policyRecords = records.filter(
        (r) => (r as any).record_kind !== "MRR" && (r as any).system === "kintsugi:policy" && (r as any).policy_before_hash && (r as any).policy_after_hash
    ) as KintsugiRecord[];

    for (const rec of policyRecords) {
        if (!rec.change_set || Object.keys(rec.change_set).length === 0) {
            warnings.push(`Policy change record missing change_set: ${rec.failure_id}`);
        }
        if (!rec.approved_by || !rec.approval_timestamp) {
            warnings.push(`Policy change record missing approval identity/timestamp: ${rec.failure_id}`);
        }
        if (rec.policy_after_hash && !snapshotHashes.has(rec.policy_after_hash)) {
            warnings.push(`Missing policy snapshot for policy_after_hash: ${rec.failure_id}`);
        }
    }

    try {
        const active = getKintsugiPolicy(repoRoot);
        const activeHash = policyHash(active);
        const known = new Set(policyRecords.map((r) => r.policy_after_hash));
        if (policyRecords.length && !known.has(activeHash)) {
            warnings.push("Active policy hash does not match any recorded policy_after_hash");
        }
    } catch {
        // ignore
    }

    return { ok: warnings.length === 0, warnings };
}
