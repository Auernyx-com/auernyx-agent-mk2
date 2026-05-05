// mondayOnboarding — three-phase Avars onboarding
// Phase 1: fixed baseline scope questions (Monday-voiced)
// Phase 2: Monday parses scope and selects only the questions that apply —
//          different vertical, different environment, different questions.
//          No generic form. Monday decides what needs to be asked.
// Phase 3: answers in, recommended config out. Human applies deliberately —
//          allowlist.json and auernyx.config.json are both in the governance hash,
//          so writing them is a governance event, not an onboarding side effect.

import * as fs from "fs";
import * as path from "path";
import { loadMondayPersona } from "../core/monday";
import { sha256Hex } from "../core/crypto";
import type { RouterContext } from "../core/router";
import type { CapabilityName } from "../core/policy";

// ─── Types ────────────────────────────────────────────────────────────────────

type Vertical = "general" | "healthcare" | "finance" | "legal" | "nonprofit" | "government" | "custom";
type Environment = "dev" | "staging" | "production";

interface OnboardingScope {
    deployment_name: string;
    vertical: Vertical;
    approver_identity: string;
    environment: Environment;
}

interface OnboardingQuestion {
    id: string;
    question: string;
    type: "boolean" | "string" | "enum";
    options?: string[];
}

interface OnboardingSession {
    session_id: string;
    started_at: string;
    phase: number;
    scope?: OnboardingScope;
    questions?: OnboardingQuestion[];
    answers?: Record<string, boolean | string>;
    completed_at?: string;
}

interface OnboardingInput {
    phase?: number;
    session_id?: string;
    scope?: Partial<OnboardingScope>;
    answers?: Record<string, boolean | string>;
}

// ─── Session storage ──────────────────────────────────────────────────────────

function sessionDir(repoRoot: string): string {
    return path.join(repoRoot, ".auernyx", "onboarding");
}

function sessionStorePath(repoRoot: string): string {
    return path.join(sessionDir(repoRoot), "sessions.ndjson");
}

function writeSession(repoRoot: string, session: OnboardingSession): void {
    const dir = sessionDir(repoRoot);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(sessionStorePath(repoRoot), JSON.stringify(session) + "\n", "utf8");
}

function readSession(repoRoot: string, sessionId: string): OnboardingSession | null {
    const p = sessionStorePath(repoRoot);
    if (!fs.existsSync(p)) return null;
    try {
        const lines = fs.readFileSync(p, "utf8").split("\n").filter(Boolean);
        for (let i = lines.length - 1; i >= 0; i--) {
            const s = JSON.parse(lines[i]) as OnboardingSession;
            if (s.session_id === sessionId) return s;
        }
    } catch { /* ignore */ }
    return null;
}

// ─── Question bank ────────────────────────────────────────────────────────────
// Each question has a condition — Monday checks scope and selects only what applies.
// Questions are written as Monday would actually say them: direct, stakes visible.

interface QuestionDef extends OnboardingQuestion {
    condition?: (scope: OnboardingScope) => boolean;
}

const QUESTION_BANK: QuestionDef[] = [
    // ── Core — always asked ────────────────────────────────────────────────────
    {
        id: "write_enabled",
        type: "boolean",
        question: [
            "Should write operations be enabled by default?",
            "Production answer is almost always no — enable it explicitly with AUERNYX_WRITE_ENABLED=1 when you actually need it.",
            "Default-off is the safe baseline. Default-on is an open door."
        ].join("\n   ")
    },
    {
        id: "daemon_secret_required",
        type: "boolean",
        question: [
            "Should the daemon require a secret header for all API access?",
            "If anything other than localhost will hit this daemon, yes. A dev-only single machine is the only case where no is reasonable.",
            "Set the secret via AUERNYX_SECRET env var — do not hardcode it."
        ].join("\n   ")
    },
    {
        id: "receipts_enabled",
        type: "boolean",
        question: [
            "Enable audit receipts for every run?",
            "Yes, unless you have a specific operational reason not to. Receipts are the evidence chain — kintsugi depends on them.",
            "Disabling receipts means no audit trail. That is a deliberate choice, not a default."
        ].join("\n   ")
    },
    {
        id: "enable_monday_hil",
        type: "boolean",
        question: [
            "Enable Monday's HIL layer?",
            "This is the human-in-the-loop communication surface — infraction review, system status, governance lock notifications, Tier 2 briefings.",
            "Disabling it removes the human communication layer entirely. The system still enforces governance, you just won't be told about it clearly."
        ].join("\n   ")
    },
    // ── Capability: Skjoldr ───────────────────────────────────────────────────
    {
        id: "enable_skjoldr",
        type: "boolean",
        question: [
            "Is Skjoldr firewall management part of this deployment?",
            "Only say yes if the Skjoldr module is being attached. Enabling the capabilities without the module does nothing useful."
        ].join("\n   ")
    },
    // ── Capability: Rollback ─────────────────────────────────────────────────
    {
        id: "enable_rollback",
        type: "boolean",
        question: [
            "Do you need known-good rollback?",
            "Tier 2, HIGH_RISK, and irreversible — changes made after the snapshot point are gone.",
            "Only enable this if you have a specific recovery workflow that requires it and someone who knows how to use it."
        ].join("\n   ")
    },
    // ── Capability: Docker ───────────────────────────────────────────────────
    {
        id: "enable_docker",
        type: "boolean",
        question: [
            "Do you need Docker operations?",
            "Tier 2, HIGH_RISK. Only enable if this deployment actively manages containers.",
            "If you're not sure, the answer is no."
        ].join("\n   ")
    },
    // ── Production-specific ───────────────────────────────────────────────────
    {
        id: "genesis_ready",
        type: "boolean",
        condition: (s) => s.environment === "production",
        question: [
            "This is a production deployment. Are you ready to seal the genesis record?",
            "Once sealed, any change to allowlist.json or auernyx.config.json is a governance event — the system detects and flags it.",
            "Make sure your configuration is final before sealing. Seal is write-once."
        ].join("\n   ")
    },
    {
        id: "production_identity_verified",
        type: "boolean",
        condition: (s) => s.environment === "production",
        question: [
            `The approver identity you set is "${"{approver_identity}"}". Is this correct for production?`,
            "This is the identity gate on every privileged and high-risk operation.",
            "A mistake here means either operations are blocked or the wrong person has authority. Verify before confirming."
        ].join("\n   ")
    },
    // ── Healthcare ────────────────────────────────────────────────────────────
    {
        id: "phi_policy_confirmed",
        type: "boolean",
        condition: (s) => s.vertical === "healthcare",
        question: [
            "This vertical handles PHI. Do you confirm a HIPAA-compliant data handling policy is in place?",
            "The healthcare vertical persona add-on ships separately and is required before production.",
            "Do not go live without it. This confirmation is logged in the onboarding record."
        ].join("\n   ")
    },
    {
        id: "phi_in_scope",
        type: "boolean",
        condition: (s) => s.vertical === "healthcare",
        question: [
            "Will this system receive or process protected health information directly?",
            "If yes, Monday's HIL layer must never surface PHI in any output. That constraint is enforced by the healthcare add-on.",
            "If no, document why PHI is out of scope — you may still need to demonstrate it."
        ].join("\n   ")
    },
    // ── Finance ───────────────────────────────────────────────────────────────
    {
        id: "audit_reads_required",
        type: "boolean",
        condition: (s) => s.vertical === "finance",
        question: [
            "Does this deployment need to log all read operations for regulatory compliance?",
            "Finance deployments often require this under SOX or similar frameworks.",
            "The enhanced audit add-on ships separately. Answer now so the onboarding record reflects the requirement."
        ].join("\n   ")
    },
    {
        id: "retention_policy_defined",
        type: "boolean",
        condition: (s) => s.vertical === "finance",
        question: [
            "Do you have a defined data retention policy for audit receipts?",
            "Finance regulators typically specify minimum retention periods. Receipts are append-only and never purge automatically.",
            "If you don't have a retention policy, get one before production."
        ].join("\n   ")
    },
    // ── Legal ─────────────────────────────────────────────────────────────────
    {
        id: "privilege_boundary_defined",
        type: "boolean",
        condition: (s) => s.vertical === "legal",
        question: [
            "Is there a defined privilege boundary for what this system can and cannot see?",
            "The legal vertical add-on enforces privilege separation. It ships separately.",
            "Define the boundary before deployment — it is much harder to add after data has flowed through."
        ].join("\n   ")
    },
    // ── Nonprofit / Squad ─────────────────────────────────────────────────────
    {
        id: "squad_connected",
        type: "boolean",
        condition: (s) => s.vertical === "nonprofit",
        question: [
            "Is this deployment connected to the Squad BattleBuddy system?",
            "If yes, the Squad integration persona, module registry, and LLM guardrails apply.",
            "Squad governance and Mk2 governance are distinct layers — both must be satisfied."
        ].join("\n   ")
    },
    // ── Government ────────────────────────────────────────────────────────────
    {
        id: "fedramp_required",
        type: "boolean",
        condition: (s) => s.vertical === "government",
        question: [
            "Does this deployment require FedRAMP compliance posture?",
            "The government vertical add-on is required before production. It does not ship with core.",
            "Do not go live without it. This is not a suggestion."
        ].join("\n   ")
    }
];

function selectQuestions(scope: OnboardingScope): OnboardingQuestion[] {
    return QUESTION_BANK
        .filter(q => !q.condition || q.condition(scope))
        .map(({ condition: _c, ...q }) => ({
            ...q,
            // Substitute scope values into question text where needed.
            question: q.question.replace('"{approver_identity}"', `"${scope.approver_identity}"`)
        }));
}

// ─── Config generation ────────────────────────────────────────────────────────

const BASE_CAPABILITIES: CapabilityName[] = [
    "scanRepo", "searchDocPreview", "memoryCheck",
    "governanceSelfTest", "governanceUnlock",
    "baselinePre", "baselinePost",
    "fenerisPrep", "proposeFixes", "analyzeDependency"
];

function buildRecommendedConfig(
    scope: OnboardingScope,
    answers: Record<string, boolean | string>
): { allowedCapabilities: CapabilityName[]; configPatch: Record<string, unknown> } {
    const caps: CapabilityName[] = [...BASE_CAPABILITIES];

    if (answers["write_enabled"]) caps.push("searchDocApply");
    if (answers["enable_monday_hil"]) {
        caps.push("mondayInfractionReview", "mondaySystemStatus", "mondayTier2Review", "mondayOnboarding");
    }
    if (answers["enable_skjoldr"]) {
        caps.push(
            "skjoldrFirewallStatus", "skjoldrFirewallAdviseInboundRuleSets",
            "skjoldrFirewallExportBaseline", "skjoldrFirewallRestoreBaseline",
            "skjoldrFirewallApplyProfile", "skjoldrFirewallApplyRulesetFile"
        );
    }
    if (answers["enable_rollback"]) caps.push("rollbackKnownGood");
    if (answers["enable_docker"]) caps.push("docker");

    return {
        allowedCapabilities: caps,
        configPatch: {
            writeEnabled: Boolean(answers["write_enabled"]),
            receiptsEnabled: answers["receipts_enabled"] !== false,
            governance: {
                approverIdentity: scope.approver_identity
            },
            daemon: {
                secret: answers["daemon_secret_required"]
                    ? "<set AUERNYX_SECRET env var — do not hardcode>"
                    : ""
            },
            monday: { llm: { provider: "", model: "" } }
        }
    };
}

// ─── Validation ───────────────────────────────────────────────────────────────

const VALID_VERTICALS: Vertical[] = ["general", "healthcare", "finance", "legal", "nonprofit", "government", "custom"];
const VALID_ENVIRONMENTS: Environment[] = ["dev", "staging", "production"];

function validateScope(scope: Partial<OnboardingScope>): string[] {
    const errors: string[] = [];
    if (!scope.deployment_name?.trim()) errors.push("deployment_name is required");
    if (!scope.vertical || !VALID_VERTICALS.includes(scope.vertical))
        errors.push(`vertical must be one of: ${VALID_VERTICALS.join(" | ")}`);
    if (!scope.approver_identity?.trim()) errors.push("approver_identity is required");
    if (!scope.environment || !VALID_ENVIRONMENTS.includes(scope.environment))
        errors.push(`environment must be one of: ${VALID_ENVIRONMENTS.join(" | ")}`);
    return errors;
}

function validateAnswers(
    answers: Record<string, boolean | string>,
    questions: OnboardingQuestion[]
): string[] {
    return questions
        .filter(q => q.type === "boolean" && typeof answers[q.id] !== "boolean")
        .map(q => `"${q.id}" requires a boolean answer (true or false)`);
}

// ─── Capability ───────────────────────────────────────────────────────────────

export async function mondayOnboarding(ctx: RouterContext, input?: unknown): Promise<unknown> {
    const persona = loadMondayPersona(ctx.repoRoot);
    const onboardingInput = (input ?? {}) as OnboardingInput;
    const phase = onboardingInput.phase ?? 1;

    // ── Phase 1: Baseline scope questions ─────────────────────────────────────
    if (phase === 1) {
        const sessionSeed = `onboarding:${ctx.sessionId}:${Date.now()}`;
        const session_id = `onboard-${sha256Hex(sessionSeed).slice(0, 16)}`;

        const intro = [
            `${persona.member}: Welcome to Avars. Four questions to start.`,
            `I need accurate answers — these set the foundation for everything that follows.`,
            ``,
            `1. deployment_name`,
            `   What do you call this deployment? This becomes the identifier in your genesis record.`,
            ``,
            `2. vertical`,
            `   What is the primary industry? This determines what I ask you next.`,
            `   Options: ${VALID_VERTICALS.join(" | ")}`,
            `   Healthcare and government have mandatory add-ons before production.`,
            `   Finance has enhanced audit requirements. Nonprofit has Squad integration.`,
            `   If you don't know yet, use general.`,
            ``,
            `3. approver_identity`,
            `   Who is the governance approver? This is the name or handle that gates every privileged operation.`,
            `   Changing it later is a governance event. Get it right.`,
            ``,
            `4. environment`,
            `   Where are you deploying? Options: ${VALID_ENVIRONMENTS.join(" | ")}`,
            `   Production changes what I ask significantly.`,
        ].join("\n");

        return {
            monday: persona.member,
            phase: 1,
            session_id,
            status: "awaiting_scope",
            human_readable: intro,
            instructions: `Resubmit with: { phase: 2, session_id: "${session_id}", scope: { deployment_name, vertical, approver_identity, environment } }`
        };
    }

    // ── Phase 2: Dynamic policy questionnaire ─────────────────────────────────
    if (phase === 2) {
        const scopeErrors = validateScope(onboardingInput.scope ?? {});
        if (scopeErrors.length > 0) {
            return {
                monday: persona.member,
                phase: 2,
                status: "scope_invalid",
                errors: scopeErrors,
                human_readable: `${persona.member}: Scope incomplete. Fix these and resubmit phase 2:\n${scopeErrors.map(e => `  - ${e}`).join("\n")}`
            };
        }

        const scope = onboardingInput.scope as OnboardingScope;
        const questions = selectQuestions(scope);

        const session: OnboardingSession = {
            session_id: onboardingInput.session_id ?? `onboard-${sha256Hex(`fallback:${Date.now()}`).slice(0, 16)}`,
            started_at: new Date().toISOString(),
            phase: 2,
            scope,
            questions
        };
        writeSession(ctx.repoRoot, session);

        const questionText = questions.map((q, i) =>
            `${i + 1}. ${q.id} (${q.type})\n   ${q.question}`
        ).join("\n\n");

        const intro = [
            `${persona.member}: Scope received — "${scope.deployment_name}", ${scope.vertical}, ${scope.environment}.`,
            ``,
            `${questions.length} question${questions.length !== 1 ? "s" : ""} for this deployment:`,
            ``,
            questionText,
            ``,
            `Answer all of these. Submit with phase: 3 and your answers keyed by question id.`
        ].join("\n");

        return {
            monday: persona.member,
            phase: 2,
            session_id: session.session_id,
            status: "awaiting_answers",
            question_count: questions.length,
            questions,
            human_readable: intro,
            instructions: `Resubmit with: { phase: 3, session_id: "${session.session_id}", answers: { ${questions.map(q => `${q.id}: true|false`).join(", ")} } }`
        };
    }

    // ── Phase 3: Generate recommended config ──────────────────────────────────
    if (phase === 3) {
        const sessionId = onboardingInput.session_id;
        if (!sessionId) {
            return {
                monday: persona.member,
                phase: 3,
                status: "session_id_required",
                human_readable: `${persona.member}: session_id is required for phase 3. Start from phase 1 if you don't have one.`
            };
        }

        const existingSession = readSession(ctx.repoRoot, sessionId);
        if (!existingSession?.scope || !existingSession.questions) {
            return {
                monday: persona.member,
                phase: 3,
                status: "session_not_found",
                human_readable: `${persona.member}: Session "${sessionId}" not found or incomplete. Restart from phase 1.`
            };
        }

        const answers = onboardingInput.answers ?? {};
        const answerErrors = validateAnswers(answers, existingSession.questions);
        if (answerErrors.length > 0) {
            return {
                monday: persona.member,
                phase: 3,
                status: "answers_invalid",
                errors: answerErrors,
                human_readable: `${persona.member}: Answers incomplete. Fix these and resubmit phase 3:\n${answerErrors.map(e => `  - ${e}`).join("\n")}`
            };
        }

        const scope = existingSession.scope;
        const { allowedCapabilities, configPatch } = buildRecommendedConfig(scope, answers);

        const completedSession: OnboardingSession = {
            ...existingSession,
            phase: 3,
            answers,
            completed_at: new Date().toISOString()
        };
        writeSession(ctx.repoRoot, completedSession);

        const applySteps = [
            "1. Write recommended_allowlist to config/allowlist.json",
            "2. Merge recommended_config_patch into config/auernyx.config.json",
            "3. If daemon_secret_required was true — set AUERNYX_SECRET env var before starting",
            "4. Start daemon once with AUERNYX_WRITE_ENABLED=1 — genesis will be created with the new hash",
            "5. Restart without AUERNYX_WRITE_ENABLED=1 for normal operation"
        ];

        const summary = [
            `${persona.member}: Onboarding complete for "${scope.deployment_name}" (${scope.vertical} / ${scope.environment}).`,
            ``,
            `Review the recommended configuration below before applying.`,
            ``,
            `IMPORTANT: allowlist.json and auernyx.config.json are both in the governance hash.`,
            `Applying these changes invalidates the genesis record if one already exists.`,
            `Apply configuration first — genesis re-seals on next startup with AUERNYX_WRITE_ENABLED=1.`,
            ``,
            `Apply steps:`,
            ...applySteps.map(s => `  ${s}`)
        ].join("\n");

        return {
            monday: persona.member,
            phase: 3,
            session_id: sessionId,
            status: "complete",
            human_readable: summary,
            recommended_allowlist: { allowedCapabilities },
            recommended_config_patch: configPatch,
            apply_steps: applySteps
        };
    }

    return {
        monday: persona.member,
        status: "invalid_phase",
        human_readable: `${persona.member}: phase must be 1, 2, or 3.`
    };
}
