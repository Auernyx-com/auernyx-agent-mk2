import * as fs from "fs";
import * as path from "path";
import { randomUUID } from "crypto";
import { sha256FileHex } from "./integrity";
import { guardedCopyFile, guardedMkdir, guardedWriteFileExclusive } from "./guardedFs";

export type KnownGoodEntry = {
    kgsId: string;
    timestamp: string;
    createdBy: string;
    reason: string;

    allowlistPath: string;
    allowlistHash: string;
    configPath: string;
    configHash: string;

    ledgerHeadHash?: string;
};

function ensureDir(repoRoot: string, dirPath: string) {
    guardedMkdir(repoRoot, dirPath, "knownGood", "mkdir");
}

function nowIso(): string {
    return new Date().toISOString();
}

function fileStamp(iso: string): string {
    // 2025-12-30T05:12:34.567Z -> 20251230T051234_567Z
    return iso.replace(/[-:]/g, "").replace(".", "_").replace("Z", "Z").replace("T", "T");
}

export function knownGoodBaseDir(repoRoot: string): string {
    return path.join(repoRoot, "artifacts", "known_good");
}

export function knownGoodEntriesDir(repoRoot: string): string {
    return path.join(knownGoodBaseDir(repoRoot), "entries");
}

export function knownGoodSnapshotsDir(repoRoot: string): string {
    return path.join(knownGoodBaseDir(repoRoot), "snapshots");
}

export function listKnownGood(repoRoot: string, options?: { limit?: number }): KnownGoodEntry[] {
    const entriesDir = knownGoodEntriesDir(repoRoot);
    if (!fs.existsSync(entriesDir)) return [];

    const files = fs
        .readdirSync(entriesDir)
        .filter((f) => f.endsWith(".kgs.json"))
        .sort();

    const all: KnownGoodEntry[] = [];
    for (const f of files) {
        try {
            const raw = fs.readFileSync(path.join(entriesDir, f), "utf8");
            all.push(JSON.parse(raw) as KnownGoodEntry);
        } catch {
            // ignore corrupted entries (append-only)
        }
    }

    const limit = options?.limit;
    return typeof limit === "number" ? all.slice(Math.max(0, all.length - limit)) : all;
}

export function recordKnownGood(
    repoRoot: string,
    params: { createdBy: string; reason: string; ledgerHeadHash?: string }
): KnownGoodEntry {
    const allowlistFile = path.join(repoRoot, "config", "allowlist.json");
    const configFile = path.join(repoRoot, "config", "auernyx.config.json");

    if (!fs.existsSync(allowlistFile)) throw new Error("Missing config/allowlist.json");
    if (!fs.existsSync(configFile)) throw new Error("Missing config/auernyx.config.json");

    const iso = nowIso();
    const kgsId = `KGS-${fileStamp(iso)}-${randomUUID().split("-")[0]}`;

    const base = knownGoodBaseDir(repoRoot);
    const entriesDir = knownGoodEntriesDir(repoRoot);
    const snapshotsDir = knownGoodSnapshotsDir(repoRoot);
    ensureDir(repoRoot, base);
    ensureDir(repoRoot, entriesDir);
    ensureDir(repoRoot, snapshotsDir);

    const snapshotDir = path.join(snapshotsDir, kgsId);
    ensureDir(repoRoot, snapshotDir);

    const allowlistSnap = path.join(snapshotDir, "allowlist.json");
    const configSnap = path.join(snapshotDir, "auernyx.config.json");

    guardedCopyFile(repoRoot, allowlistFile, allowlistSnap, "knownGood", "copy allowlist");
    guardedCopyFile(repoRoot, configFile, configSnap, "knownGood", "copy config");

    const entry: KnownGoodEntry = {
        kgsId,
        timestamp: iso,
        createdBy: params.createdBy,
        reason: params.reason,
        allowlistPath: allowlistSnap,
        allowlistHash: sha256FileHex(allowlistSnap),
        configPath: configSnap,
        configHash: sha256FileHex(configSnap),
        ledgerHeadHash: params.ledgerHeadHash,
    };

    const entryFile = path.join(entriesDir, `${fileStamp(iso)}_${kgsId}.kgs.json`);
    guardedWriteFileExclusive(repoRoot, entryFile, JSON.stringify(entry, null, 2) + "\n", "knownGood", "write entry");

    return entry;
}

export function restoreKnownGood(repoRoot: string, kgsId: string): KnownGoodEntry {
    const entries = listKnownGood(repoRoot);
    const entry = entries.find((e) => e.kgsId === kgsId);
    if (!entry) throw new Error(`Unknown KGS: ${kgsId}`);

    if (!fs.existsSync(entry.allowlistPath) || !fs.existsSync(entry.configPath)) {
        throw new Error("Snapshot files missing on disk.");
    }

    // Verify snapshot integrity before restoring.
    const allowHash = sha256FileHex(entry.allowlistPath);
    const cfgHash = sha256FileHex(entry.configPath);
    if (allowHash !== entry.allowlistHash) throw new Error("Snapshot allowlist hash mismatch.");
    if (cfgHash !== entry.configHash) throw new Error("Snapshot config hash mismatch.");

    const allowlistFile = path.join(repoRoot, "config", "allowlist.json");
    const configFile = path.join(repoRoot, "config", "auernyx.config.json");

    guardedCopyFile(repoRoot, entry.allowlistPath, allowlistFile, "knownGood", "restore allowlist");
    guardedCopyFile(repoRoot, entry.configPath, configFile, "knownGood", "restore config");

    return entry;
}
