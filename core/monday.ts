// Monday — HIL communicator and infraction disposition layer
// Translates governance events into human-readable decisions. Closes the Feneris disposition loop.
// Behavioral constraints (from persona): never flatters, never softens a decision that requires clarity.

import * as fs from "fs";
import * as path from "path";
import { sha256Hex } from "./crypto";
import type { FenerisInfraction, FenerisInfractionStatus } from "./feneris";

// ─── LLM adapter interface ────────────────────────────────────────────────────

export interface MondayLLMProvider {
    complete(systemPrompt: string, userMessage: string): Promise<string>;
}

// ─── Template provider (default — no SDK) ────────────────────────────────────
// Ships as the baseline. Real adapters (claude, openai, gemini) plug in via provider key in config.
// First Monday capability (infraction review) doesn't need real LLM calls — Feneris rationale
// fields are already plain English. The adapter is here for future onboarding / policy dialogue.

export class TemplateMondayProvider implements MondayLLMProvider {
    async complete(_systemPrompt: string, userMessage: string): Promise<string> {
        return userMessage;
    }
}

// ─── Persona ──────────────────────────────────────────────────────────────────

export interface MondayPersona {
    id: string;
    member: string;
    role: string;
    council_title: string;
    vow: { short: string; architects_mark: string };
    personality: { surface: string; core: string };
}

let _personaCache: MondayPersona | null = null;

export function loadMondayPersona(repoRoot: string): MondayPersona {
    if (_personaCache) return _personaCache;
    const personaPath = path.join(repoRoot, "personas", "monday.json");
    try {
        const raw = fs.readFileSync(personaPath, "utf8");
        _personaCache = JSON.parse(raw) as MondayPersona;
        return _personaCache;
    } catch {
        return {
            id: "monday",
            member: "Monday",
            role: "Bridge",
            council_title: "Dancer in Chaos",
            vow: { short: "I build, repair, and build again.", architects_mark: "Build. Repair. Return." },
            personality: { surface: "direct", core: "honesty without softening" }
        };
    }
}

// ─── Config ───────────────────────────────────────────────────────────────────

export interface MondayConfig {
    llm: {
        provider: string;  // "" = template (default), "claude", "openai", "gemini"
        model: string;
    };
}

export function loadMondayConfig(repoRoot: string): MondayConfig {
    const configPath = path.join(repoRoot, "config", "auernyx.config.json");
    try {
        const raw = fs.readFileSync(configPath, "utf8");
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        const monday = parsed["monday"] as Record<string, unknown> | undefined;
        const llm = monday?.["llm"] as Record<string, unknown> | undefined;
        return {
            llm: {
                provider: typeof llm?.["provider"] === "string" ? (llm["provider"] as string) : "",
                model: typeof llm?.["model"] === "string" ? (llm["model"] as string) : ""
            }
        };
    } catch {
        return { llm: { provider: "", model: "" } };
    }
}

// ─── Provider factory ─────────────────────────────────────────────────────────
// Add real adapters here by checking config.llm.provider.
// Contract: single provider per instance; no runtime switching.

export function createMondayProvider(config: MondayConfig): MondayLLMProvider {
    void config;
    return new TemplateMondayProvider();
}

// ─── Infraction formatting ────────────────────────────────────────────────────

const SEVERITY_LABEL: Record<string, string> = {
    critical: "CRITICAL",
    error: "ERROR",
    warn: "WARNING",
    info: "INFO"
};

export function formatInfractionForHuman(infraction: FenerisInfraction, repoRoot: string): string {
    const persona = loadMondayPersona(repoRoot);
    const sev = SEVERITY_LABEL[infraction.severity] ?? infraction.severity.toUpperCase();
    const score = infraction.feneris_assessment.score;
    const scoreStr =
        `scope=${score.scope}/10  severity=${score.severity}/10  sensitivity=${score.sensitivity}/10  blast=${score.blast_radius}/10`;

    const lines: string[] = [
        `--- Infraction: ${infraction.infraction_id} ---`,
        `[${sev}]  Rule: ${infraction.rule_id}`,
        `Detected: ${infraction.timestamps.detected_at}`,
        `Scope: ${infraction.scope}`,
        ``,
        `${persona.member}:`,
        infraction.feneris_assessment.rationale,
        ``,
        `Risk:    ${scoreStr}`,
        `Origin:  ${infraction.feneris_assessment.origin_point}`,
    ];

    if (infraction.notes) {
        lines.push(`Notes:   ${infraction.notes}`);
    }

    lines.push(
        ``,
        `Evidence: ${infraction.evidence.map(e => e.ref).join(" | ")}`,
        ``,
        `Disposition required — confirmed | closed | false_positive | waived`
    );

    return lines.join("\n");
}

// ─── Disposition record ───────────────────────────────────────────────────────

export type DispositionDecision = Exclude<FenerisInfractionStatus, "open">;

export interface HilDispositionRecord {
    schema: "aesir.governance.disposition.v1";
    disposition_id: string;
    infraction_id: string;
    decision: DispositionDecision;
    rationale: string;
    assessed_by: string;
    assessed_at: string;
    sha256: string;
}

function dispositionDir(repoRoot: string): string {
    return path.join(repoRoot, ".auernyx", "feneris");
}

function dispositionStorePath(repoRoot: string): string {
    return path.join(dispositionDir(repoRoot), "dispositions.ndjson");
}

export function recordHilDisposition(
    repoRoot: string,
    params: {
        infraction_id: string;
        decision: DispositionDecision;
        rationale: string;
        assessed_by: string;
    }
): HilDispositionRecord {
    const now = new Date().toISOString();
    const idSeed = `${params.infraction_id}:${now}`;
    const disposition_id = `monday-disposition-${sha256Hex(idSeed).slice(0, 16)}`;

    const contentForHash = {
        infraction_id: params.infraction_id,
        decision: params.decision,
        rationale: params.rationale,
        assessed_by: params.assessed_by,
        assessed_at: now
    };

    const record: HilDispositionRecord = {
        schema: "aesir.governance.disposition.v1",
        disposition_id,
        infraction_id: params.infraction_id,
        decision: params.decision,
        rationale: params.rationale,
        assessed_by: params.assessed_by,
        assessed_at: now,
        sha256: sha256Hex(JSON.stringify(contentForHash))
    };

    const dir = dispositionDir(repoRoot);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(dispositionStorePath(repoRoot), JSON.stringify(record) + "\n", "utf8");

    return record;
}

export function readDispositions(repoRoot: string): HilDispositionRecord[] {
    const p = dispositionStorePath(repoRoot);
    if (!fs.existsSync(p)) return [];
    try {
        return fs.readFileSync(p, "utf8")
            .split("\n")
            .filter(Boolean)
            .map(line => JSON.parse(line) as HilDispositionRecord);
    } catch {
        return [];
    }
}
