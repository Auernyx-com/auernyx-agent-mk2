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

// F_OK only tests existence, not type — a directory passes it too. The one
// real caller below needs "is this actually a file to run," not "does
// something exist at this path." Found via a test: when configuredPath
// points at an install directory (the documented, intended shape for
// auto-detection — "path" is a directory, "command" is left unset), the old
// fileExists(base) check saw the directory existed and returned the
// directory itself as the resolved command, without ever reaching the
// candidate-filename search below. available: true with a directory as
// resolvedCommand would then fail at spawn() time, not at this status
// check — false confidence exactly where a health check should catch it.
function isRegularFile(filePath: string): boolean {
    try {
        return fs.statSync(filePath).isFile();
    } catch {
        return false;
    }
}

export type SkjoldrSpawnSpec = { file: string; args: string[]; windowsVerbatimArguments?: boolean };

// Characters cmd.exe interprets even inside double quotes (or that break the
// quoting). Since Node's April 2024 security release, spawn() refuses .cmd/.bat
// without a shell exactly because of this kind of argument injection, so we
// go through cmd.exe ourselves and refuse anything we can't quote safely.
const CMD_UNSAFE = /["&|<>^%!\r\n]/;

// One place that decides HOW a resolved Skjoldr command is started, per file
// type and platform. Pure (platform is a parameter) so every branch is
// testable on any OS. Throws when the file type can't run on this platform.
export function buildSkjoldrSpawnSpec(
    commandPath: string,
    args: string[],
    platform: NodeJS.Platform = process.platform
): SkjoldrSpawnSpec {
    const a = args ?? [];
    const ext = path.extname(commandPath).toLowerCase();
    const win = platform === "win32";

    if (ext === ".ps1") {
        return {
            file: win ? "powershell.exe" : "pwsh",
            args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", commandPath, ...a],
        };
    }
    if (ext === ".cmd" || ext === ".bat") {
        if (!win) throw new Error(`Cannot run a ${ext} file on ${platform}: ${commandPath}`);
        const bad = [commandPath, ...a].find((x) => CMD_UNSAFE.test(x));
        if (bad !== undefined) {
            throw new Error(`Refusing to pass ${JSON.stringify(bad)} through cmd.exe: contains a character cmd.exe would interpret`);
        }
        const line = [commandPath, ...a].map((x) => `"${x}"`).join(" ");
        return { file: "cmd.exe", args: ["/d", "/s", "/c", `"${line}"`], windowsVerbatimArguments: true };
    }
    if (ext === ".py") {
        return { file: win ? "python" : "python3", args: [commandPath, ...a] };
    }
    return { file: commandPath, args: a };
}

// Is a bare program name (powershell.exe, pwsh, cmd.exe, python3) on PATH?
function onPath(file: string, platform: NodeJS.Platform = process.platform): boolean {
    const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
    const names = platform === "win32" && !path.extname(file) ? [file, `${file}.exe`] : [file];
    return dirs.some((d) => names.some((n) => isRegularFile(path.join(d, n))));
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

    if (isRegularFile(base)) {
        notes.push("Path points directly to an existing file; using it as command.");
        return { command: base, notes };
    }

    // SkjoldrCLI.py / SkjoldrCLI.ps1 are the real entry points in the
    // skjoldr-firewall repo (same 4-verb JSON contract). Off Windows, .exe and
    // .cmd can't run, so only the Python CLI and PowerShell (via pwsh) apply,
    // with the Python CLI first.
    const windowsCandidates = [
        "skjoldr-firewall.exe",
        "skjoldr.exe",
        "skjoldr-firewall.cmd",
        "skjoldr.cmd",
        "skjoldr-firewall.ps1",
        "skjoldr.ps1",
        "SkjoldrCLI.ps1",
        "SkjoldrCLI.py",
    ];
    const otherCandidates = ["SkjoldrCLI.py", "SkjoldrCLI.ps1", "skjoldr-firewall.ps1", "skjoldr.ps1"];
    const candidates = (process.platform === "win32" ? windowsCandidates : otherCandidates).map((name) => path.join(base, name));

    for (const candidate of candidates) {
        if (isRegularFile(candidate)) {
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

    // A resolved command is only "available" if it can actually be started
    // here: the file type must run on this platform and any interpreter it
    // needs (powershell.exe / pwsh / cmd.exe / python3) must be on PATH.
    let available = Boolean(resolved.command);
    if (resolved.command) {
        try {
            const spec = buildSkjoldrSpawnSpec(resolved.command, statusArgs);
            if (spec.file !== resolved.command && !onPath(spec.file)) {
                available = false;
                resolved.notes.push(`Needs '${spec.file}' on PATH to run ${resolved.command}; not found.`);
            }
        } catch (e) {
            available = false;
            resolved.notes.push(e instanceof Error ? e.message : String(e));
        }
    }

    return {
        enabled: true,
        configuredPath,
        resolvedCommand: resolved.command,
        statusArgs,
        json,
        timeoutMs,
        available,
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

    const spawnSpec = buildSkjoldrSpawnSpec(commandPath, args ?? []);

    return await new Promise((resolve, reject) => {
        const child = spawn(spawnSpec.file, spawnSpec.args, {
            windowsHide: true,
            windowsVerbatimArguments: spawnSpec.windowsVerbatimArguments === true,
        });

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
