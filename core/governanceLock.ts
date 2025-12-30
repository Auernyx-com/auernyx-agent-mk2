import * as fs from "fs";
import * as path from "path";

export type GovernanceLock = {
    locked: boolean;
    reason?: string;
    lastSelfTest?: { timestamp: string; ok: boolean; warnings?: string[] };
};

export function governanceLockPath(repoRoot: string): string {
    return path.join(repoRoot, "logs", "governance.lock.json");
}

export function readGovernanceLock(repoRoot: string): GovernanceLock {
    const p = governanceLockPath(repoRoot);
    if (!fs.existsSync(p)) return { locked: false };
    try {
        return JSON.parse(fs.readFileSync(p, "utf8")) as GovernanceLock;
    } catch {
        return { locked: true, reason: "lock file corrupted" };
    }
}

export function writeGovernanceLock(repoRoot: string, lock: GovernanceLock): void {
    const p = governanceLockPath(repoRoot);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(lock, null, 2) + "\n", "utf8");
}
