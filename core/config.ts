import * as fs from "fs";
import * as path from "path";

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
    daemon?: Partial<DaemonConfig>;
    paths?: {
        scanAllowedRoots?: string[];
    };

    governance?: Partial<GovernanceConfig>;

    addons?: {
        skjoldrFirewall?: Partial<SkjoldrFirewallConfig>;
    };
}

export type RiskTolerance = "SAFE" | "CONTROLLED";

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
    // SAFE means “do not allow controlled/loosening operations unless explicitly confirmed”.
    riskTolerance: "SAFE",
    // Paths are relative to repo root. Used by the guarded filesystem helpers.
    protectedPaths: [".auernyx/kintsugi/ledger/records"],
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
} {
    try {
        const filePath = path.join(repoRoot, "config", "auernyx.config.json");
        if (!fs.existsSync(filePath)) {
            return {
                daemon: DEFAULT_DAEMON,
                paths: { scanAllowedRoots: [] },
                governance: DEFAULT_GOVERNANCE,
                addons: { skjoldrFirewall: DEFAULT_SKJOLDR },
                writeEnabled: process.env.AUERNYX_WRITE_ENABLED === "1"
            };
        }

        const raw = fs.readFileSync(filePath, "utf8");
        const parsed = JSON.parse(raw) as AuernyxConfig;

        const writeEnabled =
            process.env.AUERNYX_WRITE_ENABLED === "1"
                ? true
                : process.env.AUERNYX_WRITE_ENABLED === "0"
                    ? false
                    : parsed.writeEnabled === true;

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
                    : "SAFE",
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

        return {
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
            writeEnabled
        };
    } catch {
        return {
            daemon: DEFAULT_DAEMON,
            paths: { scanAllowedRoots: [] },
            governance: DEFAULT_GOVERNANCE,
            addons: { skjoldrFirewall: DEFAULT_SKJOLDR },
            writeEnabled: process.env.AUERNYX_WRITE_ENABLED === "1"
        };
    }
}
