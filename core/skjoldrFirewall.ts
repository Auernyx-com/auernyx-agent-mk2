import * as fs from "fs";
import * as path from "path";
import { spawn } from "child_process";
import { sha256FileHex } from "./integrity";
import { loadConfig } from "./config";

export type SkjoldrFirewallStatus = {
    enabled: boolean;
    configuredPath: string;
    resolvedCommand?: string;
    statusArgs: string[];
    json: boolean;
    timeoutMs: number;
    available: boolean;
    notes: string[];

    baselineSnapshotPath?: string;
    baselineSnapshotHash?: string;
};

export type SkjoldrJsonEnvelope<T = unknown> = {
    ok: boolean;
    error_code?: string;
    message?: string;
    data?: T;
    [k: string]: unknown;
};

function fileExists(filePath: string): boolean {
    try {
        fs.accessSync(filePath, fs.constants.F_OK);
        return true;
    } catch {
        return false;
    }
}

function isPs1(commandPath: string): boolean {
    return commandPath.toLowerCase().endsWith(".ps1");
}

function resolveCommand(configuredPath: string, configuredCommand: string, allowAutoDetect: boolean): { command?: string; notes: string[] } {
    const notes: string[] = [];

    const explicit = (configuredCommand ?? "").trim();
    if (explicit) {
        notes.push("Using configured command.");
        return { command: explicit, notes };
    }

    if (!allowAutoDetect) {
        notes.push("No explicit command configured.");
        return { command: undefined, notes };
    }

    const base = (configuredPath ?? "").trim();
    if (!base) {
        notes.push("No path configured.");
        return { command: undefined, notes };
    }

    if (fileExists(base)) {
        notes.push("Path points directly to an existing file; using it as command.");
        return { command: base, notes };
    }

    const candidates = [
        "skjoldr-firewall.exe",
        "skjoldr.exe",
        "skjoldr-firewall.cmd",
        "skjoldr.cmd",
        "skjoldr-firewall.ps1",
        "skjoldr.ps1",
    ].map((name) => path.join(base, name));

    for (const candidate of candidates) {
        if (fileExists(candidate)) {
            notes.push(`Auto-resolved command: ${candidate}`);
            return { command: candidate, notes };
        }
    }

    notes.push("No executable/script auto-detected in configured path.");
    return { command: undefined, notes };
}

export function getSkjoldrFirewallStatus(repoRoot: string, options?: { allowAutoDetect?: boolean }): SkjoldrFirewallStatus {
    const cfg = loadConfig(repoRoot);
    const addon = cfg.addons?.skjoldrFirewall;

    const enabled = Boolean(addon?.enabled);
    const configuredPath = (addon?.path ?? "").trim();
    const configuredCommand = (addon?.command ?? "").trim();
    const statusArgs = Array.isArray(addon?.statusArgs) ? addon!.statusArgs : ["status"];
    const json = addon?.json !== false;
    const timeoutMs = Number.isFinite(addon?.timeoutMs) ? Number(addon?.timeoutMs) : 15000;

    const baselineSnapshotPath = (addon?.baselineSnapshotPath ?? "").trim() || undefined;
    const baselineSnapshotHash = (addon?.baselineSnapshotHash ?? "").trim() || undefined;

    if (!enabled) {
        return {
            enabled: false,
            configuredPath,
            resolvedCommand: undefined,
            statusArgs,
            json,
            timeoutMs,
            available: false,
            notes: ["Add-on disabled via config."],
            baselineSnapshotPath,
            baselineSnapshotHash,
        };
    }

    const allowAutoDetect = options?.allowAutoDetect !== false;
    const resolved = resolveCommand(configuredPath, configuredCommand, allowAutoDetect);

    return {
        enabled: true,
        configuredPath,
        resolvedCommand: resolved.command,
        statusArgs,
        json,
        timeoutMs,
        available: Boolean(resolved.command),
        notes: resolved.notes,
        baselineSnapshotPath,
        baselineSnapshotHash,
    };
}

export function parseSkjoldrJson(stdout: string): SkjoldrJsonEnvelope {
    const trimmed = (stdout ?? "").trim();
    if (!trimmed) throw new Error("Skjoldr produced no stdout (expected JSON)");

    let parsed: unknown;
    try {
        parsed = JSON.parse(trimmed);
    } catch {
        throw new Error("Skjoldr stdout was not valid JSON");
    }

    if (!parsed || typeof parsed !== "object") throw new Error("Skjoldr JSON was not an object");

    const env = parsed as SkjoldrJsonEnvelope;
    if (typeof env.ok !== "boolean") throw new Error("Skjoldr JSON missing required boolean field: ok");
    return env;
}

export async function runSkjoldrCommand(
    resolvedCommand: string,
    args: string[],
    timeoutMs: number
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
    const commandPath = resolvedCommand;

    const spawnSpec = isPs1(commandPath)
        ? {
              file: "powershell.exe",
              args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", commandPath, ...(args ?? [])],
          }
        : {
              file: commandPath,
              args: args ?? [],
          };

    return await new Promise((resolve, reject) => {
        const child = spawn(spawnSpec.file, spawnSpec.args, { windowsHide: true });

        let stdout = "";
        let stderr = "";

        const timer = setTimeout(() => {
            try {
                child.kill();
            } catch {
                // ignore
            }
            reject(new Error(`Skjoldr command timed out after ${timeoutMs}ms`));
        }, timeoutMs);

        child.stdout?.on("data", (d) => {
            stdout += String(d);
        });
        child.stderr?.on("data", (d) => {
            stderr += String(d);
        });

        child.on("error", (err) => {
            clearTimeout(timer);
            reject(err);
        });
        child.on("close", (code) => {
            clearTimeout(timer);
            resolve({ exitCode: code, stdout, stderr });
        });
    });
}

export async function runSkjoldrJsonCommand(
    resolvedCommand: string,
    args: string[],
    timeoutMs: number
): Promise<SkjoldrJsonEnvelope> {
    const result = await runSkjoldrCommand(resolvedCommand, args, timeoutMs);
    if (result.exitCode !== 0) {
        const msg = (result.stderr || result.stdout || "").trim();
        throw new Error(`Skjoldr exited non-zero (code=${String(result.exitCode)}): ${msg || "(no output)"}`);
    }
    return parseSkjoldrJson(result.stdout);
}

export function verifyBaselineSnapshot(filePath: string, pinnedHash: string): { ok: true; actualHash: string } | { ok: false; error: string; actualHash?: string } {
    try {
        if (!fileExists(filePath)) return { ok: false, error: `Missing snapshot file: ${filePath}` };
        const actual = sha256FileHex(filePath);
        if (actual.trim().toLowerCase() !== pinnedHash.trim().toLowerCase()) {
            return { ok: false, error: `hash mismatch: pinned=${pinnedHash} actual=${actual}`, actualHash: actual };
        }
        return { ok: true, actualHash: actual };
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { ok: false, error: msg };
    }
}
