import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

export type ReceiptEvent = {
    ts: string;
    kind: string;
    data?: unknown;
};

export type ReceiptWriter = {
    runId: string;
    dirPath: string;
    writeJson(name: string, value: unknown): void;
    writeText(name: string, value: string): void;
    appendNdjson(name: string, value: unknown): void;
    ensureEmptyFile(name: string): void;
    appendEvent(kind: string, data?: unknown): void;
    finalize(): { runId: string; dirPath: string };
};

function sha256Hex(buf: Buffer | string): string {
    return crypto.createHash("sha256").update(buf).digest("hex");
}

function ensureDir(p: string) {
    if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function ensureParentDir(filePath: string) {
    const dir = path.dirname(filePath);
    ensureDir(dir);
}

export function createReceiptWriter(repoRoot: string, options: { receiptsEnabled: boolean }): ReceiptWriter | null {
    if (!options.receiptsEnabled) return null;

    const runId = `${Date.now()}-${crypto.randomBytes(6).toString("hex")}`;
    const baseDir = path.join(repoRoot, ".auernyx", "receipts", runId);
    try {
        ensureDir(baseDir);
    } catch {
        return null;
    }

    const eventsPath = path.join(baseDir, "events.ndjson");
    const ndjsonFiles = new Set<string>();

    const writeJson = (name: string, value: unknown) => {
        try {
            const filePath = path.join(baseDir, name);
            ensureParentDir(filePath);
            const body = JSON.stringify(value, null, 2) + "\n";
            fs.writeFileSync(filePath, body, "utf8");
            const hash = sha256Hex(body);
            fs.writeFileSync(filePath + ".sha256", hash + "\n", "utf8");
        } catch {
            // ignore
        }
    };

    const writeText = (name: string, value: string) => {
        try {
            const filePath = path.join(baseDir, name);
            ensureParentDir(filePath);
            const body = (value ?? "") + (value.endsWith("\n") ? "" : "\n");
            fs.writeFileSync(filePath, body, "utf8");
            const hash = sha256Hex(body);
            fs.writeFileSync(filePath + ".sha256", hash + "\n", "utf8");
        } catch {
            // ignore
        }
    };

    const ensureEmptyFile = (name: string) => {
        try {
            const filePath = path.join(baseDir, name);
            ensureParentDir(filePath);
            if (fs.existsSync(filePath)) return;
            fs.writeFileSync(filePath, "", "utf8");
            fs.writeFileSync(filePath + ".sha256", sha256Hex("") + "\n", "utf8");
        } catch {
            // ignore
        }
    };

    const appendNdjson = (name: string, value: unknown) => {
        try {
            const filePath = path.join(baseDir, name);
            ensureParentDir(filePath);
            ndjsonFiles.add(filePath);
            fs.appendFileSync(filePath, JSON.stringify(value) + "\n", "utf8");
        } catch {
            // ignore
        }
    };

    const appendEvent = (kind: string, data?: unknown) => {
        try {
            const event: ReceiptEvent = { ts: new Date().toISOString(), kind, data };
            fs.appendFileSync(eventsPath, JSON.stringify(event) + "\n", "utf8");
        } catch {
            // ignore
        }
    };

    const finalize = () => {
        try {
            if (fs.existsSync(eventsPath)) {
                const raw = fs.readFileSync(eventsPath);
                fs.writeFileSync(eventsPath + ".sha256", sha256Hex(raw) + "\n", "utf8");
            }

            for (const fp of ndjsonFiles) {
                try {
                    const raw = fs.readFileSync(fp);
                    fs.writeFileSync(fp + ".sha256", sha256Hex(raw) + "\n", "utf8");
                } catch {
                    // ignore
                }
            }
        } catch {
            // ignore
        }
        return { runId, dirPath: baseDir };
    };

    return { runId, dirPath: baseDir, writeJson, writeText, appendNdjson, ensureEmptyFile, appendEvent, finalize };
}
