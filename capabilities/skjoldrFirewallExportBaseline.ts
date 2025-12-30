import type { RouterContext } from "../core/router";
import * as fs from "fs";
import { sha256FileHex } from "../core/integrity";
import { getSkjoldrFirewallStatus, runSkjoldrJsonCommand } from "../core/skjoldrFirewall";

function extractSnapshotPath(env: any): string | undefined {
    const candidates = [env?.snapshot_path, env?.snapshotPath, env?.path, env?.file, env?.snapshot];
    for (const c of candidates) {
        if (typeof c === "string" && c.trim()) return c.trim();
    }
    const data = env?.data;
    if (data && typeof data === "object") {
        const nested = [data.snapshot_path, data.snapshotPath, data.path, data.file, data.snapshot];
        for (const c of nested) {
            if (typeof c === "string" && c.trim()) return c.trim();
        }
    }
    return undefined;
}

function extractHash(env: any): string | undefined {
    const candidates = [env?.hash, env?.sha256, env?.snapshot_hash, env?.snapshotHash];
    for (const c of candidates) {
        if (typeof c === "string" && c.trim()) return c.trim();
    }
    const data = env?.data;
    if (data && typeof data === "object") {
        const nested = [data.hash, data.sha256, data.snapshot_hash, data.snapshotHash];
        for (const c of nested) {
            if (typeof c === "string" && c.trim()) return c.trim();
        }
    }
    return undefined;
}

export async function skjoldrFirewallExportBaseline(ctx: RouterContext, _input?: unknown): Promise<unknown> {
    const status = getSkjoldrFirewallStatus(ctx.repoRoot, { allowAutoDetect: false });
    if (!status.enabled) throw new Error("Skjoldr Firewall add-on is disabled.");
    if (!status.available || !status.resolvedCommand) throw new Error("Skjoldr command not configured/resolved.");
    if (!status.json) throw new Error("Refusing to export baseline without JSON mode.");

    const common = ["--json", "--timeout", String(status.timeoutMs)];

    const exported = await runSkjoldrJsonCommand(status.resolvedCommand, ["export", ...common], status.timeoutMs);
    if (!exported.ok) throw new Error("Skjoldr export returned ok=false");

    const snapshotPath = extractSnapshotPath(exported);
    if (!snapshotPath) throw new Error("Skjoldr export JSON did not include a snapshot path");
    if (!fs.existsSync(snapshotPath)) throw new Error(`Skjoldr snapshot path does not exist: ${snapshotPath}`);

    const snapshotHash = extractHash(exported);
    const computedHash = sha256FileHex(snapshotPath);
    const pinnedHash = snapshotHash?.trim() ? snapshotHash.trim() : computedHash;

    return { ok: true, exported, baselineSnapshotPath: snapshotPath, baselineSnapshotHash: pinnedHash, computedHash };
}
