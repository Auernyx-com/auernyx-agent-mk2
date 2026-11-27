import * as fs from "fs";
import * as path from "path";

// Add a simple cache to avoid repeated file reads
const configCache = new Map<string, { config: any; mtime: number }>();

function getCachedConfig(filePath: string): any | null {
    try {
        const stat = fs.statSync(filePath);
        const cached = configCache.get(filePath);
        if (cached && cached.mtime === stat.mtimeMs) {
            return cached.config;
        }
        return null;
    } catch {
        return null;
    }
}

// Env wins over the file: "1" forces on, "0" forces off, anything else = file value.
// Returns a copy so the cached file-only object is never mutated.
function applyEnvOverrides<T extends { writeEnabled: boolean; receiptsEnabled: boolean }>(cfg: T): T {
    const w = process.env.AUERNYX_WRITE_ENABLED;
    const r = process.env.AUERNYX_RECEIPTS_ENABLED;
    return {
        ...cfg,
        writeEnabled: w === "1" ? true : w === "0" ? false : cfg.writeEnabled,
        receiptsEnabled: r === "1" ? true : r === "0" ? false : cfg.receiptsEnabled,
    };
}

function setCachedConfig(filePath: string, config: any, mtime: number): void {
    configCache.set(filePath, { config, mtime });
}

export interface DaemonConfig {
    host: string;
    port: number;
    secret?: string;
    maxBodyBytes?: number;
    rateLimit?: {
        windowMs: number;
        maxRequests: number;
    };
}

export interface AuernyxConfig {
    writeEnabled?: boolean;
    receiptsEnabled?: boolean;
    daemon?: Partial<DaemonConfig>;
    paths?: {
        scanAllowedRoots?: string[];
    };

    governance?: Partial<GovernanceConfig>;

    addons?: {
        skjoldrFirewall?: Partial<SkjoldrFirewallConfig>;
    };
}

export type RiskTolerance = "WITHIN_TOLERANCE" | "CONTROLLED" | "FAILED_CLOSED";

export interface RollbackPolicyConfig {
    allowRollback: boolean;
    rollbackWindowDays: number;
    rollbackMaxDepth: number;
    rollbackRequiresIntegrityPass: boolean;
}

export interface GovernanceConfig {
    approverIdentity: string;
    riskTolerance: RiskTolerance;
    protectedPaths: string[];
    rollback: RollbackPolicyConfig;
}

export interface SkjoldrFirewallConfig {
    enabled: boolean;
    path: string;
    command: string;
    statusArgs: string[];
    json: boolean;
    timeoutMs: number;
    baselineSnapshotPath?: string;
    baselineSnapshotHash?: string;
}

const DEFAULT_DAEMON: Required<DaemonConfig> = {
    host: "127.0.0.1",
    port: 43117,
    secret: "",
    maxBodyBytes: 64 * 1024,
    rateLimit: {
        windowMs: 10_000,
        maxRequests: 30
    }
};

const DEFAULT_SKJOLDR: SkjoldrFirewallConfig = {
    enabled: false,
    path: "",
    command: "",
    statusArgs: ["status"],
    json: true,
    timeoutMs: 15000,
    baselineSnapshotPath: "",
    baselineSnapshotHash: ""
};

const DEFAULT_GOVERNANCE: GovernanceConfig = {
    // Empty => no identity check enforced.
    approverIdentity: "",
    riskTolerance: "WITHIN_TOLERANCE",
    // Paths are relative to repo root. Used by the guarded filesystem helpers.
    // These must stay in sync with the hard-coded PROTECTED_CONTAINS in kintsugi/protectedPaths.ts
    // so that both witnesses independently protect the same critical systems.
    protectedPaths: [
        ".auernyx/kintsugi/ledger/records",
        ".auernyx/kintsugi/policy/history",
        ".auernyx/kintsugi/policy/active.policy.json",
    ],
    rollback: {
        allowRollback: false,
        rollbackWindowDays: 14,
        rollbackMaxDepth: 3,
        rollbackRequiresIntegrityPass: true
    }
};

export function loadConfig(repoRoot: string): {
    daemon: DaemonConfig;
    paths: { scanAllowedRoots: string[] };
    governance: GovernanceConfig;
    addons: { skjoldrFirewall: SkjoldrFirewallConfig };
    writeEnabled: boolean;
    receiptsEnabled: boolean;
} {
    const filePath = path.join(repoRoot, "config", "auernyx.config.json");
    
    // Check cache first. The cache holds the FILE's values only; env
    // overrides are applied on every call so a changed AUERNYX_WRITE_ENABLED /
    // AUERNYX_RECEIPTS_ENABLED takes effect without waiting for a file change.
    const cached = getCachedConfig(filePath);
    if (cached) {
        return applyEnvOverrides(cached);
    }
    
    {
        let stat: fs.Stats;
        let raw: string;
        try {
            stat = fs.statSync(filePath);
            raw = fs.readFileSync(filePath, "utf8");
        } catch (err) {
            // Only a MISSING file means "use defaults". A file that exists but
            // can't be read (permissions, it's a directory, ...) fails closed.
            if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
                throw new Error(`refusing to load config: ${filePath} exists but could not be read: ${(err as Error)?.message ?? String(err)}`);
            }
            const defaultConfig = {
                daemon: DEFAULT_DAEMON,
                paths: { scanAllowedRoots: [] },
                governance: DEFAULT_GOVERNANCE,
                addons: { skjoldrFirewall: DEFAULT_SKJOLDR },
                writeEnabled: false,
                receiptsEnabled: true
            };
            return applyEnvOverrides(defaultConfig);
        }

        // Fail closed on a broken file. Silently falling back to defaults here
        // used to turn daemon auth off (secret ""), reset protectedPaths and
        // blank approverIdentity on a single typo, with no warning.
        let parsedUnknown: unknown;
        try {
            parsedUnknown = JSON.parse(raw);
        } catch (err) {
            throw new Error(`refusing to load config: ${filePath} is not valid JSON (${(err as Error)?.message ?? String(err)}). Fix or remove the file.`);
        }
        if (parsedUnknown === null || typeof parsedUnknown !== "object" || Array.isArray(parsedUnknown)) {
            throw new Error(`refusing to load config: ${filePath} must be a JSON object at the top level. Fix or remove the file.`);
        }
        const parsed = parsedUnknown as AuernyxConfig;

        // File values only; env overrides are applied in applyEnvOverrides.
        const writeEnabled = parsed.writeEnabled === true;
        const receiptsEnabled = parsed.receiptsEnabled !== false;

        const host = parsed.daemon?.host ?? DEFAULT_DAEMON.host;
        const port = Number(parsed.daemon?.port ?? DEFAULT_DAEMON.port);
        const secret = typeof parsed.daemon?.secret === "string" ? parsed.daemon.secret : DEFAULT_DAEMON.secret;
        const maxBodyBytes = Number(parsed.daemon?.maxBodyBytes ?? DEFAULT_DAEMON.maxBodyBytes);

        const windowMs = Number(parsed.daemon?.rateLimit?.windowMs ?? DEFAULT_DAEMON.rateLimit.windowMs);
        const maxRequests = Number(parsed.daemon?.rateLimit?.maxRequests ?? DEFAULT_DAEMON.rateLimit.maxRequests);

        const scanAllowedRoots = Array.isArray(parsed.paths?.scanAllowedRoots)
            ? parsed.paths!.scanAllowedRoots!.filter((p): p is string => typeof p === "string" && p.trim().length > 0)
            : [];

        const govRaw = parsed.governance;
        const governance: GovernanceConfig = {
            approverIdentity:
                typeof (govRaw as any)?.approverIdentity === "string" ? String((govRaw as any).approverIdentity) : DEFAULT_GOVERNANCE.approverIdentity,
            riskTolerance:
                (String((govRaw as any)?.riskTolerance ?? DEFAULT_GOVERNANCE.riskTolerance).toUpperCase() as RiskTolerance) === "CONTROLLED"
                    ? "CONTROLLED"
                    : "WITHIN_TOLERANCE",
            protectedPaths: Array.isArray((govRaw as any)?.protectedPaths)
                ? (govRaw as any).protectedPaths.filter((p: any) => typeof p === "string" && p.trim().length > 0)
                : DEFAULT_GOVERNANCE.protectedPaths,
            rollback: {
                allowRollback:
                    typeof (govRaw as any)?.rollback?.allowRollback === "boolean"
                        ? Boolean((govRaw as any).rollback.allowRollback)
                        : DEFAULT_GOVERNANCE.rollback.allowRollback,
                rollbackWindowDays: Number((govRaw as any)?.rollback?.rollbackWindowDays ?? DEFAULT_GOVERNANCE.rollback.rollbackWindowDays),
                rollbackMaxDepth: Number((govRaw as any)?.rollback?.rollbackMaxDepth ?? DEFAULT_GOVERNANCE.rollback.rollbackMaxDepth),
                rollbackRequiresIntegrityPass:
                    typeof (govRaw as any)?.rollback?.rollbackRequiresIntegrityPass === "boolean"
                        ? Boolean((govRaw as any).rollback.rollbackRequiresIntegrityPass)
                        : DEFAULT_GOVERNANCE.rollback.rollbackRequiresIntegrityPass,
            }
        };

        const skjoldrRaw = parsed.addons?.skjoldrFirewall;
        const skjoldr: SkjoldrFirewallConfig = {
            enabled: typeof skjoldrRaw?.enabled === "boolean" ? skjoldrRaw.enabled : DEFAULT_SKJOLDR.enabled,
            path: typeof skjoldrRaw?.path === "string" ? skjoldrRaw.path : DEFAULT_SKJOLDR.path,
            command: typeof skjoldrRaw?.command === "string" ? skjoldrRaw.command : DEFAULT_SKJOLDR.command,
            statusArgs: Array.isArray(skjoldrRaw?.statusArgs)
                ? skjoldrRaw!.statusArgs!.filter((a): a is string => typeof a === "string" && a.trim().length > 0)
                : DEFAULT_SKJOLDR.statusArgs,
            json: typeof skjoldrRaw?.json === "boolean" ? skjoldrRaw.json : DEFAULT_SKJOLDR.json,
            timeoutMs: Number(skjoldrRaw?.timeoutMs ?? DEFAULT_SKJOLDR.timeoutMs),
            baselineSnapshotPath:
                typeof (skjoldrRaw as any)?.baselineSnapshotPath === "string"
                    ? String((skjoldrRaw as any).baselineSnapshotPath)
                    : DEFAULT_SKJOLDR.baselineSnapshotPath,
            baselineSnapshotHash:
                typeof (skjoldrRaw as any)?.baselineSnapshotHash === "string"
                    ? String((skjoldrRaw as any).baselineSnapshotHash)
                    : DEFAULT_SKJOLDR.baselineSnapshotHash,
        };

        const result = {
            daemon: {
                host,
                port: Number.isFinite(port) && port > 0 ? port : DEFAULT_DAEMON.port,
                secret,
                maxBodyBytes: Number.isFinite(maxBodyBytes) && maxBodyBytes > 0 ? maxBodyBytes : DEFAULT_DAEMON.maxBodyBytes,
                rateLimit: {
                    windowMs: Number.isFinite(windowMs) && windowMs > 0 ? windowMs : DEFAULT_DAEMON.rateLimit.windowMs,
                    maxRequests: Number.isFinite(maxRequests) && maxRequests > 0 ? maxRequests : DEFAULT_DAEMON.rateLimit.maxRequests
                }
            },
            paths: {
                scanAllowedRoots
            },
            governance: {
                ...governance,
                approverIdentity: String(governance.approverIdentity ?? "").trim(),
                protectedPaths: Array.isArray(governance.protectedPaths)
                    ? governance.protectedPaths.map((p) => String(p).replace(/\\/g, "/").trim()).filter((p) => p.length > 0)
                    : DEFAULT_GOVERNANCE.protectedPaths,
                rollback: {
                    allowRollback: Boolean(governance.rollback?.allowRollback),
                    rollbackWindowDays:
                        Number.isFinite(governance.rollback?.rollbackWindowDays) && (governance.rollback!.rollbackWindowDays as number) > 0
                            ? (governance.rollback!.rollbackWindowDays as number)
                            : DEFAULT_GOVERNANCE.rollback.rollbackWindowDays,
                    rollbackMaxDepth:
                        Number.isFinite(governance.rollback?.rollbackMaxDepth) && (governance.rollback!.rollbackMaxDepth as number) > 0
                            ? (governance.rollback!.rollbackMaxDepth as number)
                            : DEFAULT_GOVERNANCE.rollback.rollbackMaxDepth,
                    rollbackRequiresIntegrityPass: Boolean(governance.rollback?.rollbackRequiresIntegrityPass ?? DEFAULT_GOVERNANCE.rollback.rollbackRequiresIntegrityPass)
                }
            },
            addons: {
                skjoldrFirewall: {
                    ...skjoldr,
                    timeoutMs: Number.isFinite(skjoldr.timeoutMs) && skjoldr.timeoutMs > 0 ? skjoldr.timeoutMs : DEFAULT_SKJOLDR.timeoutMs,
                }
            },
            writeEnabled,
            receiptsEnabled
        };

        setCachedConfig(filePath, result, stat.mtimeMs);
        return applyEnvOverrides(result);
    }
}
