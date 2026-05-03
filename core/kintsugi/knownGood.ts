import * as fs from "fs";
import * as path from "path";
import { randomUUID } from "crypto";
import { getApproverIdentity, getLastLedgerRecord, makeMfr, makeSnapshotHash, recordFailure } from "./memory";

const KINTSUGI_DIR = path.join(".auernyx", "kintsugi");
const ENTRIES_DIR = path.join(KINTSUGI_DIR, "known_good", "entries");

export type KnownGoodSnapshotEntry = {
    kgs_id: string;
    timestamp: string;
    policy_snapshot_path: string;
    policy_hash: string;
    ledger_head_hash: string;
    created_by: string;
    reason: string;
    notes?: string;
};

function fileTimestamp(iso: string): string {
    return iso.replace(/:/g, "").replace(/-/g, "").replace(".", "_");
}

function kgsId(nowIso: string): string {
    const stamp = fileTimestamp(nowIso);
    const short = randomUUID().split("-")[0];
    return `KGS-${stamp}-${short}`;
}

function stableStringify(input: unknown): string {
    return JSON.stringify(sortKeysDeep(input));
}

function sortKeysDeep(input: unknown): unknown {
    if (Array.isArray(input)) return input.map(sortKeysDeep);
    if (input && typeof input === "object") {
        const obj = input as Record<string, unknown>;
        const out: Record<string, unknown> = {};
        for (const key of Object.keys(obj).sort()) {
            const value = obj[key];
            if (value === undefined) continue;
            out[key] = sortKeysDeep(value);
        }
        return out;
    }
    return input;
}

export async function listKnownGoodSnapshotsWithPaths(
    repoRoot: string,
    options?: { limit?: number }
): Promise<Array<{ filePath: string; entry: KnownGoodSnapshotEntry }>> {
    const base = path.join(repoRoot, ENTRIES_DIR);
    if (!fs.existsSync(base)) return [];

    const filesAll = fs
        .readdirSync(base)
        .filter((f) => f.endsWith(".kgs.json"))
        .sort();

    const limit = options?.limit;
    const files = typeof limit === "number" ? filesAll.slice(Math.max(0, filesAll.length - limit)) : filesAll;

    const entries: Array<{ filePath: string; entry: KnownGoodSnapshotEntry }> = [];
    for (const file of files) {
        const filePath = path.join(base, file);
        try {
            const raw = fs.readFileSync(filePath, { encoding: "utf8" });
            entries.push({ filePath, entry: JSON.parse(raw) as KnownGoodSnapshotEntry });
        } catch {
            // Append-only: do not delete/repair here.
        }
    }
    return entries;
}

export async function recordKnownGoodSnapshot(
    repoRoot: string,
    params: {
        policySnapshotPath: string;
        policyHash: string;
        approvedBy?: string;
        reason: string;
        notes?: string;
    }
): Promise<KnownGoodSnapshotEntry> {
    const nowIso = new Date().toISOString();
    const base = path.join(repoRoot, ENTRIES_DIR);
    fs.mkdirSync(base, { recursive: true });

    // Ensure the ledger has at least one record so we can anchor known-good snapshots.
    // Fresh repos may have policy initialized without any ledger entries yet.
    let head = await getLastLedgerRecord(repoRoot);
    let ledgerHeadHash = String((head as any)?.record_hash ?? "");
    if (!ledgerHeadHash) {
        const approvedBy = params.approvedBy ?? getApproverIdentity(repoRoot);
        await recordFailure(repoRoot, {
            ...makeMfr({
                system: "kintsugi:known-good",
                failure_type: "governance",
                trigger: "Initialize ledger anchor for known-good snapshot",
                inputs_snapshot: makeSnapshotHash({
                    policy_snapshot_path: params.policySnapshotPath,
                    policy_hash: params.policyHash,
                    reason: params.reason,
                }),
                pre_state: params.policyHash,
                post_state: params.policyHash,
                recovery_action: "none",
                authorized_by: approvedBy,
                notes: "Genesis ledger record to anchor known-good snapshots.",
            }),
            severity: "LOW",
            normalized_error_code: "KINTSUGI_KNOWN_GOOD_ANCHOR",
            signature: "governance::kintsugi:known-good::anchor::KINTSUGI_KNOWN_GOOD_ANCHOR",
            approved_by: approvedBy,
            approval_timestamp: new Date().toISOString(),
            risk_level: "CONTROLLED",
            blast_radius: ["kintsugi-ledger"],
            baseline_snapshot_path: params.policySnapshotPath,
            baseline_snapshot_hash: params.policyHash,
        }).catch(() => undefined);

        head = await getLastLedgerRecord(repoRoot);
        ledgerHeadHash = String((head as any)?.record_hash ?? "");
        if (!ledgerHeadHash) {
            throw new Error("Cannot mark Known Good: ledger head hash unavailable");
        }
    }

    const approvedBy = params.approvedBy ?? getApproverIdentity(repoRoot);

    const entry: KnownGoodSnapshotEntry = {
        kgs_id: kgsId(nowIso),
        timestamp: nowIso,
        policy_snapshot_path: params.policySnapshotPath,
        policy_hash: params.policyHash,
        ledger_head_hash: ledgerHeadHash,
        created_by: makeSnapshotHash(approvedBy),
        reason: params.reason,
        notes: params.notes,
    };

    const fileName = `${fileTimestamp(nowIso)}_${entry.kgs_id}.kgs.json`;
    const filePath = path.join(base, fileName);
    fs.writeFileSync(filePath, stableStringify(entry) + "\n", { encoding: "utf8", flag: "wx" });
    return entry;
}
