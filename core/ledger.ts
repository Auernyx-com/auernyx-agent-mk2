import * as fs from "fs";
import * as path from "path";
import { sha256Hex, stableStringify } from "./crypto";

export interface LedgerEntry {
    ts: string;
    sessionId: string;
    event: string;
    data?: unknown;
    prevHash?: string;
    hash: string;
    // Present and false only when the entry could not actually be written to
    // disk (lock contention timed out). Absent — not merely true — for every
    // normal, successfully-persisted append, so existing callers that never
    // check this field see no shape change. Without this, a caller had no
    // way to tell a real append apart from one that computed a valid-looking
    // hash and then silently never touched the ledger file.
    persisted?: false;
}


export class Ledger {
    private readonly ledgerPath: string;
    private lastHash: string | undefined;
    private readonly writeEnabled: boolean;
    private readonly lockPath: string;

    constructor(repoRoot: string, options?: { writeEnabled?: boolean }) {
        this.writeEnabled = options?.writeEnabled ?? true;

        const logsDir = path.join(repoRoot, "logs");
        if (this.writeEnabled && !fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
        this.ledgerPath = path.join(logsDir, "ledger.ndjson");
        this.lockPath = path.join(logsDir, "ledger.ndjson.lock");

        if (fs.existsSync(this.ledgerPath)) {
            const lines = fs.readFileSync(this.ledgerPath, "utf8").trim().split(/\r?\n/);
            const tail = lines.length ? lines[lines.length - 1] : undefined;
            if (tail) {
                try {
                    const parsed = JSON.parse(tail) as Partial<LedgerEntry>;
                    if (typeof parsed.hash === "string") this.lastHash = parsed.hash;
                } catch {
                    // ignore
                }
            }
        }
    }

    private getTailHashFromFile(): string | undefined {
        if (!fs.existsSync(this.ledgerPath)) return undefined;
        const lines = fs.readFileSync(this.ledgerPath, "utf8").trim().split(/\r?\n/);
        const tail = lines.length ? lines[lines.length - 1] : undefined;
        if (!tail) return undefined;
        try {
            const parsed = JSON.parse(tail) as Partial<LedgerEntry>;
            return typeof parsed.hash === "string" ? parsed.hash : undefined;
        } catch {
            return undefined;
        }
    }

    private withLock<T>(fn: () => T): { acquired: true; value: T } | { acquired: false } {
        const deadline = Date.now() + 2000;
        while (true) {
            try {
                const fd = fs.openSync(this.lockPath, "wx");
                try {
                    return { acquired: true, value: fn() };
                } finally {
                    try {
                        fs.closeSync(fd);
                    } catch {
                        // ignore
                    }
                    try {
                        fs.unlinkSync(this.lockPath);
                    } catch {
                        // ignore
                    }
                }
            } catch {
                if (Date.now() > deadline) {
                    return { acquired: false };
                }
                // Busy wait with a tiny delay.
                const start = Date.now();
                while (Date.now() - start < 15) {
                    // spin
                }
            }
        }
    }

    append(sessionId: string, event: string, data?: unknown): LedgerEntry {
        const ts = new Date().toISOString();

        const computeEntry = (prevHash: string | undefined): LedgerEntry => {
            const toHash = stableStringify({ ts, sessionId, event, data, prevHash });
            const hash = sha256Hex(toHash);
            return { ts, sessionId, event, data, prevHash, hash };
        };

        if (!this.writeEnabled) {
            return computeEntry(this.lastHash);
        }

        const locked = this.withLock(() => {
            const prevHash = this.getTailHashFromFile() ?? this.lastHash;
            const entry = computeEntry(prevHash);
            fs.appendFileSync(this.ledgerPath, JSON.stringify(entry) + "\n");
            this.lastHash = entry.hash;
            return entry;
        });

        if (locked.acquired) return locked.value;

        // Could not acquire the lock: do not write (prevents hash-chain forks).
        // This is a real, audit-relevant event — the caller asked for an
        // observation to be recorded and it wasn't — so it's surfaced two
        // ways: a console warning (visible operationally even if the caller
        // ignores the return value) and persisted: false on the returned
        // entry (visible programmatically to any caller that checks).
        console.warn(
            `[ledger] could not acquire lock within timeout — entry NOT written: session=${sessionId} event=${event}`
        );
        const bestEffortPrev = this.getTailHashFromFile() ?? this.lastHash;
        return { ...computeEntry(bestEffortPrev), persisted: false };
    }
}
