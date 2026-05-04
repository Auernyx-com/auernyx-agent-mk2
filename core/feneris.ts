// Feneris — Watchdog and Sentinel
// Monitors for governance and policy violations. Emits OPEN infractions with evidence.
// Constraints (all hard_refusal): FENERIS.MONITOR.ONLY, FENERIS.NO_SIDE_EFFECTS,
// FENERIS.NO_AUTONOMOUS_ENFORCEMENT, FENERIS.INFRACTION.RAISE_OPEN_ONLY,
// FENERIS.NO_VERDICT, FENERIS.EVIDENCE.REQUIRED, FENERIS.NO_NETWORK_SIDE_EFFECTS

import * as fs from "fs";
import * as path from "path";
import { sha256Hex, stableStringify } from "./crypto";
import { isJudgmentActive, judgmentPath, genesisPath } from "./provenance";
import { readGovernanceLock } from "./governanceLock";
import { getKintsugiPolicy } from "./kintsugi/memory";
import type { CapabilityName } from "./policy";

// ─── Score types ────────────────────────────────────────────────────────────

export type FenerisScore = {
    scope: number;        // 1–10: single component → system-wide
    severity: number;     // 1–10: minor drift → governance law violated
    sensitivity: number;  // 1–10: non-sensitive → credentials/bypass → loss of control
    blast_radius: number; // 1–10: self-contained → uncontrolled cascade
};

export type FenerisAssessment = {
    score: FenerisScore;
    origin_point: string; // check:<id>|component:<name>|path:<file-if-applicable>
    rationale: string;
};

export type FenerisHilAssessment = {
    score: FenerisScore;
    rationale: string;
    assessed_by: string;
    assessed_at: string; // ISO 8601
};

// ─── Infraction record ───────────────────────────────────────────────────────

export type FenerisInfractionSeverity = "info" | "warn" | "error" | "critical";
export type FenerisInfractionStatus = "open" | "confirmed" | "closed" | "false_positive" | "waived";

export type FenerisInfraction = {
    schema: "aesir.governance.infraction.v1";
    infraction_id: string;
    scope: string;
    rule_id: string;
    severity: FenerisInfractionSeverity;
    status: FenerisInfractionStatus;
    detected_by: {
        actor_id: "feneris";
        method: "sentinel_scan";
    };
    timestamps: {
        detected_at: string;
        last_updated_at?: string;
    };
    evidence: Array<{
        ref: string;
        sha256: string;
        kind?: string;
    }>;
    feneris_assessment: FenerisAssessment;
    hil_assessment?: FenerisHilAssessment;
    notes?: string;
};

// ─── Scan report ─────────────────────────────────────────────────────────────

export type FenerisScanReport = {
    scanned_at: string;
    session_id: string;
    infractions_raised: number;
    infractions: FenerisInfraction[];
    summary: string;
    constraints_honored: string[];
};

// ─── Store management ────────────────────────────────────────────────────────

function fenerisDir(repoRoot: string): string {
    return path.join(repoRoot, ".auernyx", "feneris");
}

export function infractionStorePath(repoRoot: string): string {
    return path.join(fenerisDir(repoRoot), "infractions.ndjson");
}

export function appendInfraction(repoRoot: string, infraction: FenerisInfraction): void {
    const dir = fenerisDir(repoRoot);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(
        infractionStorePath(repoRoot),
        JSON.stringify(infraction) + "\n",
        "utf8"
    );
}

export function readOpenInfractions(repoRoot: string): FenerisInfraction[] {
    const p = infractionStorePath(repoRoot);
    if (!fs.existsSync(p)) return [];
    try {
        return fs.readFileSync(p, "utf8")
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line) as FenerisInfraction)
            .filter((r) => r.status === "open");
    } catch {
        return [];
    }
}

export function hasCriticalOpenInfractions(repoRoot: string): boolean {
    return readOpenInfractions(repoRoot).some(
        (r) => r.severity === "critical" || r.severity === "error"
    );
}

// ─── Evidence helpers ────────────────────────────────────────────────────────

function makeEvidence(checkId: string, observed: unknown, detectedAt: string) {
    const content = stableStringify({ check: checkId, observed, detected_at: detectedAt });
    return [{
        ref: `feneris:scan:${checkId}:${detectedAt}`,
        sha256: sha256Hex(content),
        kind: "scan_observation"
    }];
}

function makeId(checkId: string, ts: string): string {
    return `feneris-${checkId}-${ts.replace(/[^0-9]/g, "")}`;
}

// ─── Individual checks ───────────────────────────────────────────────────────

function checkAllowlistIntegrity(repoRoot: string, ts: string): FenerisInfraction | null {
    const allowlistPath = path.join(repoRoot, "config", "allowlist.json");
    let observed: unknown;
    let parsed: { allowedCapabilities?: unknown[] } | null = null;

    try {
        if (!fs.existsSync(allowlistPath)) {
            observed = { exists: false };
        } else {
            const raw = fs.readFileSync(allowlistPath, "utf8");
            parsed = JSON.parse(raw) as { allowedCapabilities?: unknown[] };
            observed = { exists: true, entry_count: Array.isArray(parsed?.allowedCapabilities) ? parsed.allowedCapabilities.length : "non-array" };
        }
    } catch (e) {
        observed = { exists: true, parse_error: e instanceof Error ? e.message : String(e) };
    }

    if (!parsed) {
        return null;
    }

    const entries = Array.isArray(parsed.allowedCapabilities) ? parsed.allowedCapabilities : [];
    if (entries.length === 0) {
        return {
            schema: "aesir.governance.infraction.v1",
            infraction_id: makeId("allowlist-empty", ts),
            scope: "trunk",
            rule_id: "FENERIS.ALLOWLIST.EMPTY",
            severity: "critical",
            status: "open",
            detected_by: { actor_id: "feneris", method: "sentinel_scan" },
            timestamps: { detected_at: ts },
            evidence: makeEvidence("allowlist-empty", observed, ts),
            feneris_assessment: {
                score: { scope: 10, severity: 9, sensitivity: 8, blast_radius: 10 },
                origin_point: `check:allowlist-integrity|component:policy|path:config/allowlist.json`,
                rationale: "Allowlist is empty after system initialization. Nothing can execute. Either the file was cleared maliciously or the system was misconfigured. Scope and blast radius are maximum — the entire capability layer is disabled."
            },
            notes: "config/allowlist.json exists but allowedCapabilities is empty. No capabilities can run until this is restored."
        };
    }

    return null;
}

function checkJudgmentActive(repoRoot: string, ts: string): FenerisInfraction | null {
    if (!isJudgmentActive(repoRoot)) return null;

    let judgmentContent: unknown = null;
    try {
        const p = judgmentPath(repoRoot);
        if (fs.existsSync(p)) {
            judgmentContent = JSON.parse(fs.readFileSync(p, "utf8"));
        }
    } catch {
        judgmentContent = { parse_error: true };
    }

    return {
        schema: "aesir.governance.infraction.v1",
        infraction_id: makeId("obsidian-judgment-active", ts),
        scope: "trunk",
        rule_id: "FENERIS.JUDGMENT.ACTIVE",
        severity: "error",
        status: "open",
        detected_by: { actor_id: "feneris", method: "sentinel_scan" },
        timestamps: { detected_at: ts },
        evidence: makeEvidence("obsidian-judgment-active", { judgment: judgmentContent }, ts),
        feneris_assessment: {
            score: { scope: 8, severity: 9, sensitivity: 7, blast_radius: 8 },
            origin_point: `check:obsidian-judgment|component:provenance|path:.auernyx/provenance/judgment.json`,
            rationale: "Obsidian's Judgment is active. Provenance verification failed — governance files may have been tampered with. All non-read-only operations are blocked by Obsidian. Feneris records independently as its own infraction for dual-witness purposes."
        },
        notes: "Provenance failure triggered Obsidian's Judgment. HIL must investigate the cause before clearing."
    };
}

function checkGovernanceLock(repoRoot: string, ts: string): FenerisInfraction | null {
    const lock = readGovernanceLock(repoRoot);
    if (!lock.locked) return null;

    const reasonLegible = typeof lock.reason === "string" && lock.reason.trim().length > 0;
    const observed = { locked: true, reason: lock.reason ?? null, legible: reasonLegible };

    if (!reasonLegible) {
        return {
            schema: "aesir.governance.infraction.v1",
            infraction_id: makeId("lock-damaged-reason", ts),
            scope: "trunk",
            rule_id: "FENERIS.LOCK.ACTIVE_UNKNOWN_REASON",
            severity: "error",
            status: "open",
            detected_by: { actor_id: "feneris", method: "sentinel_scan" },
            timestamps: { detected_at: ts },
            evidence: makeEvidence("governance-lock-damaged", observed, ts),
            feneris_assessment: {
                score: { scope: 7, severity: 7, sensitivity: 5, blast_radius: 7 },
                origin_point: `check:governance-lock|component:governance|path:logs/governance.lock.json`,
                rationale: "Governance lock is active but has no legible reason. A damaged or reason-free lock file is a potential tampering signal — a legitimate lock always records why it was set. Cannot distinguish intentional maintenance lock from injected lock without a reason string."
            },
            notes: "The governance lock file is active but the reason field is missing or empty. HIL must verify the lock is intentional before clearing."
        };
    }

    return {
        schema: "aesir.governance.infraction.v1",
        infraction_id: makeId("lock-active", ts),
        scope: "trunk",
        rule_id: "FENERIS.LOCK.ACTIVE_KNOWN_REASON",
        severity: "warn",
        status: "open",
        detected_by: { actor_id: "feneris", method: "sentinel_scan" },
        timestamps: { detected_at: ts },
        evidence: makeEvidence("governance-lock-active", observed, ts),
        feneris_assessment: {
            score: { scope: 5, severity: 4, sensitivity: 3, blast_radius: 5 },
            origin_point: `check:governance-lock|component:governance|path:logs/governance.lock.json`,
            rationale: "Governance lock is active with a legible reason. Lower severity than an unexplained lock — the operator has documented intent. Still flagged because a lock in production requires HIL acknowledgment and eventual clearance."
        },
        notes: `Governance lock is active: "${lock.reason}". Normal if intentional maintenance is in progress.`
    };
}

function checkReceiptChain(repoRoot: string, ts: string): FenerisInfraction | null {
    const receiptsDir = path.join(repoRoot, ".auernyx", "receipts");

    if (!fs.existsSync(receiptsDir)) {
        return {
            schema: "aesir.governance.infraction.v1",
            infraction_id: makeId("receipt-store-missing", ts),
            scope: "trunk",
            rule_id: "FENERIS.RECEIPT.STORE_MISSING",
            severity: "info",
            status: "open",
            detected_by: { actor_id: "feneris", method: "sentinel_scan" },
            timestamps: { detected_at: ts },
            evidence: makeEvidence("receipt-store-missing", { receipts_dir_exists: false }, ts),
            feneris_assessment: {
                score: { scope: 2, severity: 1, sensitivity: 1, blast_radius: 1 },
                origin_point: `check:receipt-chain|component:receipts|path:.auernyx/receipts`,
                rationale: "Receipt directory does not exist. Likely a fresh system that has not yet executed any operations. Low severity but noted — the audit trail has not yet been established."
            },
            notes: "System appears new. No operations have produced receipts yet."
        };
    }

    const scanStartMs = Date.parse(ts);
    let runDirs: string[] = [];
    try {
        runDirs = fs.readdirSync(receiptsDir)
            .filter((name) => {
                // Exclude the current in-progress run: its receipt won't have final.json yet
                const runMs = parseInt(name.split("-")[0] ?? "0", 10);
                return !isNaN(runMs) && runMs < scanStartMs - 2000;
            })
            .map((d) => path.join(receiptsDir, d))
            .filter((d) => {
                try { return fs.statSync(d).isDirectory(); } catch { return false; }
            })
            .sort()
            .slice(-5); // check last 5 completed runs
    } catch {
        return null;
    }

    if (runDirs.length === 0) return null;

    const incomplete = runDirs.filter((d) => {
        const finalPath = path.join(d, "final.json");
        return !fs.existsSync(finalPath);
    });

    if (incomplete.length === 0) return null;

    const observed = {
        checked_runs: runDirs.length,
        incomplete_count: incomplete.length,
        incomplete_ids: incomplete.map((d) => path.basename(d))
    };

    const severity: FenerisInfractionSeverity = incomplete.length >= 3 ? "error" : "warn";
    const score: FenerisScore = incomplete.length >= 3
        ? { scope: 5, severity: 7, sensitivity: 5, blast_radius: 5 }
        : { scope: 3, severity: 5, sensitivity: 4, blast_radius: 3 };

    return {
        schema: "aesir.governance.infraction.v1",
        infraction_id: makeId("receipt-incomplete", ts),
        scope: "trunk",
        rule_id: "FENERIS.RECEIPT.INCOMPLETE",
        severity,
        status: "open",
        detected_by: { actor_id: "feneris", method: "sentinel_scan" },
        timestamps: { detected_at: ts },
        evidence: makeEvidence("receipt-incomplete", observed, ts),
        feneris_assessment: {
            score,
            origin_point: `check:receipt-chain|component:receipts|path:.auernyx/receipts`,
            rationale: `${incomplete.length} of the last ${runDirs.length} run receipts are missing final.json. A complete receipt is mandatory — every run must finalize. Missing finals indicate interrupted runs, crashes, or deliberate suppression of the audit trail.`
        },
        notes: `Incomplete receipts: ${observed.incomplete_ids.join(", ")}`
    };
}

function checkKintsugiPolicy(repoRoot: string, ts: string): FenerisInfraction | null {
    try {
        const policy = getKintsugiPolicy(repoRoot);
        const knownStates = ["WITHIN_TOLERANCE", "CONTROLLED", "FAILED_CLOSED"];
        if (policy && knownStates.includes(policy.riskTolerance)) return null;

        const observed = { policy_readable: !!policy, risk_tolerance: policy?.riskTolerance ?? null };
        return {
            schema: "aesir.governance.infraction.v1",
            infraction_id: makeId("kintsugi-policy-invalid", ts),
            scope: "trunk",
            rule_id: "FENERIS.KINTSUGI.POLICY_INVALID_STATE",
            severity: "error",
            status: "open",
            detected_by: { actor_id: "feneris", method: "sentinel_scan" },
            timestamps: { detected_at: ts },
            evidence: makeEvidence("kintsugi-policy-invalid", observed, ts),
            feneris_assessment: {
                score: { scope: 6, severity: 7, sensitivity: 6, blast_radius: 7 },
                origin_point: `check:kintsugi-policy|component:kintsugi|path:.auernyx/kintsugi/policy/active.policy.json`,
                rationale: "Kintsugi active policy has an unrecognized riskTolerance value. The canonical vocabulary defines exactly three states: WITHIN_TOLERANCE, CONTROLLED, FAILED_CLOSED. An unknown value indicates drift, tampering, or a schema migration that was not properly authorized."
            },
            notes: `Active policy riskTolerance is "${policy?.riskTolerance ?? "unreadable"}". Must be one of: WITHIN_TOLERANCE, CONTROLLED, FAILED_CLOSED.`
        };
    } catch {
        return {
            schema: "aesir.governance.infraction.v1",
            infraction_id: makeId("kintsugi-policy-unreadable", ts),
            scope: "trunk",
            rule_id: "FENERIS.KINTSUGI.POLICY_UNREADABLE",
            severity: "error",
            status: "open",
            detected_by: { actor_id: "feneris", method: "sentinel_scan" },
            timestamps: { detected_at: ts },
            evidence: makeEvidence("kintsugi-policy-unreadable", { readable: false }, ts),
            feneris_assessment: {
                score: { scope: 6, severity: 7, sensitivity: 6, blast_radius: 7 },
                origin_point: `check:kintsugi-policy|component:kintsugi|path:.auernyx/kintsugi/policy/active.policy.json`,
                rationale: "Kintsugi active policy could not be read. All risk-tolerance decisions depend on this file. An unreadable policy means the system cannot correctly classify operation risk. Risk elevation (Tier 2) is effectively blocked, but the cause must be investigated."
            },
            notes: "Active policy file is unreadable. May indicate a corrupted write, protected path violation, or missing initialization."
        };
    }
}

function checkGenesisRecord(repoRoot: string, ts: string): FenerisInfraction | null {
    const p = genesisPath(repoRoot);
    if (fs.existsSync(p)) return null;

    return {
        schema: "aesir.governance.infraction.v1",
        infraction_id: makeId("provenance-genesis-missing", ts),
        scope: "trunk",
        rule_id: "FENERIS.PROVENANCE.GENESIS_MISSING",
        severity: "critical",
        status: "open",
        detected_by: { actor_id: "feneris", method: "sentinel_scan" },
        timestamps: { detected_at: ts },
        evidence: makeEvidence("provenance-genesis-missing", { genesis_path: p, exists: false }, ts),
        feneris_assessment: {
            score: { scope: 8, severity: 9, sensitivity: 7, blast_radius: 9 },
            origin_point: `check:provenance-genesis|component:provenance|path:.auernyx/provenance/genesis.json`,
            rationale: "The genesis record is missing. Every run verifies provenance against genesis.json — its absence means the next run will trigger Obsidian's Judgment and block all privileged operations. On an initialized system, genesis should always be present. Its absence after initialization is a serious signal."
        },
        notes: "genesis.json is missing. Provenance verification will fail on the next run unless the system is in write-enabled mode and can recreate it."
    };
}

// ─── Sentinel scan ───────────────────────────────────────────────────────────

export function runSentinelScan(repoRoot: string, sessionId: string): FenerisScanReport {
    const ts = new Date().toISOString();

    const checks = [
        checkAllowlistIntegrity(repoRoot, ts),
        checkJudgmentActive(repoRoot, ts),
        checkGovernanceLock(repoRoot, ts),
        checkReceiptChain(repoRoot, ts),
        checkKintsugiPolicy(repoRoot, ts),
        checkGenesisRecord(repoRoot, ts),
    ];

    const infractions = checks.filter((c): c is FenerisInfraction => c !== null);

    for (const infraction of infractions) {
        appendInfraction(repoRoot, infraction);
    }

    const criticalCount = infractions.filter((i) => i.severity === "critical").length;
    const errorCount = infractions.filter((i) => i.severity === "error").length;

    const summary = infractions.length === 0
        ? "Sentinel scan complete. No infractions detected. System within tolerance."
        : `Sentinel scan complete. ${infractions.length} infraction(s) raised: ${criticalCount} critical, ${errorCount} error. All status OPEN — HIL disposition required.`;

    return {
        scanned_at: ts,
        session_id: sessionId,
        infractions_raised: infractions.length,
        infractions,
        summary,
        constraints_honored: [
            "FENERIS.MONITOR.ONLY",
            "FENERIS.NO_SIDE_EFFECTS",
            "FENERIS.NO_AUTONOMOUS_ENFORCEMENT",
            "FENERIS.INFRACTION.RAISE_OPEN_ONLY",
            "FENERIS.NO_VERDICT",
            "FENERIS.EVIDENCE.REQUIRED",
            "FENERIS.NO_NETWORK_SIDE_EFFECTS"
        ]
    };
}
