#!/usr/bin/env node

/**
 * Auernyx Mk2 - Headless CLI Client
 * 
 * This is one of two independent agents in Mk2:
 * 1. VS Code Extension (clients/vscode/extension.ts) - for VS Code users
 * 2. Headless Agent (this file + auernyx-daemon.ts) - for CLI and browser UI users
 * 
 * The headless agent operates independently and does not require VS Code.
 * 
 * Execution flow:
 * - First attempts to delegate to daemon (if running) for shared state
 * - Falls back to local execution if daemon unavailable
 * - No VS Code dependencies - uses readline for interactive approval
 */

import { createCore } from "../../core/server";
import { tryRunViaDaemon } from "../../core/daemonClient";
import { createHumanApproval } from "../../core/approvals";
import { capabilityRequiresApproval, CapabilityName, getCapabilityMeta } from "../../core/policy";
import { runLifecycle } from "../../core/runLifecycle";
import { loadConfig } from "../../core/config";
import { planForIntent } from "../../core/planner";
import * as readline from "readline";

function planLooksReadOnly(plan: any): boolean {
    const steps = plan?.steps;
    if (!Array.isArray(steps) || steps.length === 0) return false;
    return steps.every((s: any) => String(s?.type ?? "").toUpperCase() === "READ_ONLY");
}

async function promptApproval(capability: string): Promise<string | null> {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const question = (q: string) => new Promise<string>((resolve) => rl.question(q, resolve));

    try {
        const answer = (await question(`Approval required for ${capability}. Type a reason (or leave blank to cancel): `)).trim();
        return answer.length > 0 ? answer : null;
    } finally {
        rl.close();
    }
}

async function promptText(prompt: string): Promise<string | null> {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const question = (q: string) => new Promise<string>((resolve) => rl.question(q, resolve));

    try {
        const answer = (await question(prompt)).trim();
        return answer.length > 0 ? answer : null;
    } finally {
        rl.close();
    }
}

function usageAndExit(): never {
    // eslint-disable-next-line no-console
    console.error(
        [
            "Usage:",
            "  auernyx <intent...>",
            "",
            "Common examples:",
            "  auernyx scan [<path>]",
            "  auernyx memory",
            "  auernyx baseline pre",
            "  auernyx rollback list [--limit <n>]",
            "  auernyx rollback restore <KGS_ID>",
            "  auernyx propose [--limit <n>]",
            "  auernyx propose apply <SUGGESTION_ID>",
            "  auernyx governance self-test",
            "  auernyx governance unlock",
            "  auernyx skjoldr status",
            "  auernyx skjoldr apply-profile <NAME>",
            "  auernyx skjoldr apply-ruleset <FILE>",
            "  auernyx skjoldr export-baseline",
            "  auernyx skjoldr restore-baseline [--snapshot <FILE>] [--hash <SHA256>]",
            "",
            "Non-interactive approvals:",
            "  --reason <TEXT>         Approval reason (skips prompts)",
            "  --identity <TEXT>       Approver identity (when required)",
            "  --apply                 Arm mutating operations (required)",
            "  --allow-dirty           Allow apply on dirty working tree",
            "  --confirm APPLY         (legacy) confirm phrase; implied by --apply",
            "",
            "Execution routing:",
            "  --no-daemon             Force local execution (skip daemon)",
            "  --local                 Alias for --no-daemon"
        ].join("\n")
    );
    process.exit(1);
}

function hasFlag(argv: string[], name: string): boolean {
    return argv.includes(name);
}

function parseIntFlag(argv: string[], name: string): number | undefined {
    const i = argv.indexOf(name);
    if (i < 0) return undefined;
    const raw = argv[i + 1];
    if (typeof raw !== "string") return undefined;
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
}

function parseStringFlag(argv: string[], name: string): string | undefined {
    const i = argv.indexOf(name);
    if (i < 0) return undefined;
    const raw = argv[i + 1];
    return typeof raw === "string" ? raw : undefined;
}

function parseApprovalFlags(argv: string[]): {
    nonInteractive: boolean;
    reason?: string;
    identity?: string;
    apply: boolean;
    allowDirty: boolean;
    confirm?: "APPLY";
} {
    const reason = parseStringFlag(argv, "--reason") ?? parseStringFlag(argv, "--approve-reason");
    const identity = parseStringFlag(argv, "--identity");
    const apply = hasFlag(argv, "--apply");
    const allowDirty = hasFlag(argv, "--allow-dirty");
    const confirmRaw = parseStringFlag(argv, "--confirm");
    const confirm = confirmRaw === "APPLY" ? "APPLY" : undefined;
    return {
        nonInteractive: typeof reason === "string" && reason.trim().length > 0,
        reason: typeof reason === "string" ? reason.trim() : undefined,
        identity: typeof identity === "string" ? identity.trim() : undefined,
        apply,
        allowDirty,
        confirm
    };
}

function buildStructuredInput(argv: string[]): { daemonInput: unknown; daemonIntent: string; controlled: boolean } {
    if (argv.length === 0) usageAndExit();

    const primary = (argv[0] ?? "").toLowerCase();

    // Default: no structured input, pass through raw intent.
    let daemonIntent = argv.join(" ").trim();
    let daemonInput: unknown = undefined;
    let controlled = false;

    if (primary === "scan") {
        const target = typeof argv[1] === "string" && !argv[1].startsWith("--") ? argv[1] : undefined;
        if (typeof target === "string") daemonInput = { targetDir: target };
        return { daemonInput, daemonIntent, controlled };
    }

    if (primary === "rollback") {
        const action = (argv[1] ?? "list").toLowerCase();
        if (action === "list") {
            const limit = parseIntFlag(argv, "--limit");
            daemonInput = { action: "list", ...(typeof limit === "number" ? { limit } : {}) };
            return { daemonInput, daemonIntent, controlled };
        }
        if (action === "restore") {
            const kgsId = String(argv[2] ?? "").trim();
            if (!kgsId) {
                // eslint-disable-next-line no-console
                console.error("Missing KGS_ID for rollback restore");
                process.exit(1);
            }
            daemonInput = { action: "restore", kgsId };
            controlled = true;
            return { daemonInput, daemonIntent, controlled };
        }
        return { daemonInput, daemonIntent, controlled };
    }

    if (primary === "propose") {
        const sub = (argv[1] ?? "").toLowerCase();
        const limit = parseIntFlag(argv, "--limit");

        if (sub === "apply") {
            const suggestionId = String(argv[2] ?? "").trim();
            if (!suggestionId) {
                // eslint-disable-next-line no-console
                console.error("Missing SUGGESTION_ID for propose apply");
                process.exit(1);
            }
            daemonInput = {
                apply: true,
                suggestionId,
                ...(typeof limit === "number" ? { limit } : {})
            };

            // Ensure the router maps this to proposeFixes.
            daemonIntent = `propose fixes apply ${suggestionId}`;
            controlled = true;
            return { daemonInput, daemonIntent, controlled };
        }

        daemonInput = { ...(typeof limit === "number" ? { limit } : {}) };
        // Ensure routing is stable.
        daemonIntent = "propose fixes";
        return { daemonInput, daemonIntent, controlled };
    }

    if (primary === "governance") {
        const sub = (argv[1] ?? "").toLowerCase();
        if (sub === "self-test" || sub === "selftest") {
            daemonIntent = "governance self-test";
        } else if (sub === "unlock") {
            daemonIntent = "governance unlock";
        }
        return { daemonInput, daemonIntent, controlled };
    }

    if (primary === "skjoldr") {
        const sub = (argv[1] ?? "").toLowerCase();
        if (sub === "status") {
            daemonIntent = "skjoldr status";
            return { daemonInput, daemonIntent, controlled };
        }

        if (sub === "apply-profile") {
            const profile = String(argv[2] ?? "").trim();
            if (!profile) {
                // eslint-disable-next-line no-console
                console.error("Missing profile name for skjoldr apply-profile");
                process.exit(1);
            }
            daemonInput = { profile };
            daemonIntent = `skjoldr apply profile ${profile}`;
            controlled = true;
            return { daemonInput, daemonIntent, controlled };
        }

        if (sub === "apply-ruleset") {
            const rulesetPath = String(argv[2] ?? "").trim();
            if (!rulesetPath) {
                // eslint-disable-next-line no-console
                console.error("Missing ruleset file path for skjoldr apply-ruleset");
                process.exit(1);
            }
            daemonInput = { rulesetPath };
            daemonIntent = `skjoldr apply ruleset file ${rulesetPath}`;
            controlled = true;
            return { daemonInput, daemonIntent, controlled };
        }

        if (sub === "export-baseline") {
            daemonIntent = "skjoldr export baseline";
            return { daemonInput, daemonIntent, controlled };
        }

        if (sub === "restore-baseline") {
            const snapshot = parseStringFlag(argv, "--snapshot");
            const hash = parseStringFlag(argv, "--hash");
            daemonInput = {
                ...(snapshot ? { baselineSnapshotPath: snapshot } : {}),
                ...(hash ? { baselineSnapshotHash: hash } : {})
            };
            daemonIntent = "skjoldr restore baseline";
            controlled = true;
            return { daemonInput, daemonIntent, controlled };
        }

        return { daemonInput, daemonIntent, controlled };
    }

    return { daemonInput, daemonIntent, controlled };
}

function buildNextCommandHint(args: {
    raw: string;
    effectiveControlled: boolean;
    identityRequiredForControlled: boolean;
    hasNoDaemon: boolean;
    hasReason: boolean;
    hasConfirmApply: boolean;
    hasApplyFlag: boolean;
    hasAllowDirtyFlag: boolean;
    hasIdentity: boolean;
}): string {
    const base = `auernyx ${args.raw}`.trim();
    const extra: string[] = [];

    if (!args.hasNoDaemon) extra.push("--local");
    if (args.effectiveControlled && !args.hasApplyFlag) extra.push("--apply");
    if (args.effectiveControlled && args.hasAllowDirtyFlag) extra.push("--allow-dirty");

    // For controlled operations, provide a non-interactive copy/paste path.
    if (args.effectiveControlled && !args.hasReason) extra.push('--reason "<WHY>"');
    if (args.effectiveControlled && args.identityRequiredForControlled && !args.hasIdentity) extra.push('--identity "<IDENTITY>"');

    return extra.length ? `${base} ${extra.join(" ")}` : base;
}

async function main() {
    const repoRoot = process.cwd();
    const argv = process.argv.slice(2);
    const raw = argv.join(" ").trim();

    const noDaemon = hasFlag(argv, "--no-daemon") || hasFlag(argv, "--local") || process.env.AUERNYX_NO_DAEMON === "1";

    const approvalFlags = parseApprovalFlags(argv);

    if (!raw) {
        // eslint-disable-next-line no-console
        console.error("Usage: auernyx <intent>");
        process.exit(1);
    }

    if (!raw) usageAndExit();

    // Minimal structured inputs (deterministic) for supported commands.
    const { daemonIntent, daemonInput, controlled } = buildStructuredInput(argv);

    const cfg = loadConfig(repoRoot);
    const identityRequiredForControlled = cfg.governance.approverIdentity.trim().length > 0;

    const hasReasonFlag = typeof parseStringFlag(argv, "--reason") === "string" || typeof parseStringFlag(argv, "--approve-reason") === "string";
    const hasConfirmApplyFlag = parseStringFlag(argv, "--confirm") === "APPLY";
    const hasApplyFlag = hasFlag(argv, "--apply");
    const hasAllowDirtyFlag = hasFlag(argv, "--allow-dirty");
    const hasIdentityFlag = typeof parseStringFlag(argv, "--identity") === "string";

    // Try daemon first (unless explicitly disabled).
    let daemonResp = noDaemon ? null : await tryRunViaDaemon({ repoRoot }, daemonIntent, daemonInput);
    if (daemonResp !== null) {
        if (
            daemonResp !== null &&
            !daemonResp.ok &&
            (daemonResp.error === "approval_required" || daemonResp.error === "step_approval_required")
        ) {
            const cap = daemonResp.capability ?? "capability";
            const capName = (typeof daemonResp.capability === "string" ? daemonResp.capability : undefined) as CapabilityName | undefined;
            const meta = capName ? getCapabilityMeta(capName) : undefined;
            const daemonPlan = (daemonResp as any)?.result?.plan;
            const effectiveControlled = controlled || (meta ? !meta.readOnly : !planLooksReadOnly(daemonPlan));

            // READ_ONLY: no prompts; still emits approvals for audit trail.
            const reasonInput = effectiveControlled
                ? (approvalFlags.nonInteractive ? approvalFlags.reason! : await promptApproval(cap))
                : (typeof approvalFlags.reason === "string" && approvalFlags.reason.trim().length > 0 ? approvalFlags.reason.trim() : "read-only auto-approved");
            if (effectiveControlled && !reasonInput) process.exit(4);
            const reason = typeof reasonInput === "string" && reasonInput.trim().length > 0 ? reasonInput.trim() : "read-only auto-approved";

            const identity = effectiveControlled && identityRequiredForControlled
                ? (approvalFlags.nonInteractive ? approvalFlags.identity : await promptText(`Approver identity required. Type identity (expected: ${cfg.governance.approverIdentity}): `))
                : null;
            if (effectiveControlled && identityRequiredForControlled && (!identity || identity.trim().length === 0)) process.exit(4);

            const approval = createHumanApproval(reason, {
                identity: identity ?? undefined,
                apply: effectiveControlled && approvalFlags.apply ? true : undefined,
                allowDirty: effectiveControlled && approvalFlags.apply && approvalFlags.allowDirty ? true : undefined,
                confirm: effectiveControlled && approvalFlags.apply ? "APPLY" : undefined
            });

            const retry = await tryRunViaDaemon({ repoRoot }, daemonIntent, daemonInput, approval);
            if (retry === null) {
                // daemon disappeared mid-flight; fall through to local
                daemonResp = null;
            } else {
                daemonResp = retry;
            }
        }

        // If we ended up with write_disabled from a read-only daemon, reroute controlled ops locally.
        // This is not a bypass: local execution still requires approvals + confirm APPLY.
        if (daemonResp !== null && !daemonResp.ok && String(daemonResp.error ?? "").trim() === "write_disabled") {
            const capName = (typeof daemonResp.capability === "string" ? daemonResp.capability : undefined) as CapabilityName | undefined;
            const meta = capName ? getCapabilityMeta(capName) : undefined;
            const effectiveControlled = controlled || (meta ? !meta.readOnly : false);

            if (effectiveControlled) {
                const next = buildNextCommandHint({
                    raw,
                    effectiveControlled,
                    identityRequiredForControlled,
                    hasNoDaemon: noDaemon,
                    hasReason: hasReasonFlag,
                    hasConfirmApply: hasConfirmApplyFlag,
                    hasApplyFlag,
                    hasAllowDirtyFlag,
                    hasIdentity: hasIdentityFlag
                });

                // Informational only: we're about to recover by routing locally.
                // Use stdout so scripts don't treat this as a failure.
                // eslint-disable-next-line no-console
                console.log("NOTICE: Controlled op hit read-only daemon; routing locally.");
                // eslint-disable-next-line no-console
                console.log("NEXT (copy/paste): " + next);
                daemonResp = null;
            }
        }

        if (daemonResp !== null) {
            if (!daemonResp.ok) {
                // eslint-disable-next-line no-console
                console.error(daemonResp.error ?? "daemon error");
                process.exit(3);
            }

            // eslint-disable-next-line no-console
            console.log(JSON.stringify({ capability: daemonResp.capability, result: daemonResp.result }, null, 2));
            return;
        }
    }

    const core = createCore(repoRoot);
    const capability = core.router.route({ raw: daemonIntent });
    if (!capability) {
        // eslint-disable-next-line no-console
        console.error(`Unroutable intent: ${daemonIntent}`);
        process.exit(2);
    }

    const localInput = daemonInput;

    // Mutating steps require confirm=APPLY at execution time.
    const meta = getCapabilityMeta(capability as CapabilityName);
    const effectiveControlled = controlled || !meta.readOnly;

    // Governed execution requires per-step approvals.
    // READ_ONLY: auto-approve to remove production friction while keeping receipts/auditability.
    const reasonInput = effectiveControlled
        ? (approvalFlags.nonInteractive ? approvalFlags.reason! : await promptApproval(capability))
        : (typeof approvalFlags.reason === "string" && approvalFlags.reason.trim().length > 0 ? approvalFlags.reason.trim() : "read-only auto-approved");
    if (effectiveControlled && !reasonInput) process.exit(4);
    const reason = typeof reasonInput === "string" && reasonInput.trim().length > 0 ? reasonInput.trim() : "read-only auto-approved";

    const identity = effectiveControlled && identityRequiredForControlled
        ? (approvalFlags.nonInteractive ? approvalFlags.identity : await promptText(`Approver identity required. Type identity (expected: ${cfg.governance.approverIdentity}): `))
        : null;
    if (effectiveControlled && identityRequiredForControlled && (!identity || identity.trim().length === 0)) process.exit(4);

    const approval = createHumanApproval(reason, {
        identity: identity ?? undefined,
        apply: effectiveControlled && approvalFlags.apply ? true : undefined,
        allowDirty: effectiveControlled && approvalFlags.apply && approvalFlags.allowDirty ? true : undefined,
        confirm: effectiveControlled && approvalFlags.apply ? "APPLY" : undefined
    });

    const plan = planForIntent(core.router, daemonIntent, localInput);
    const stepApprovals = plan.steps.map((s) => ({ ...approval, stepId: s.id }));

    const lifecycle = await runLifecycle({
        router: core.router,
        ctx: { repoRoot, sessionId: core.sessionId, ledger: core.ledger },
        intent: daemonIntent,
        input: localInput,
        stepApprovals,
    });

    if (!lifecycle.ok) {
        if (lifecycle.refusal?.code === "write_disabled" && effectiveControlled && !cfg.writeEnabled) {
            // eslint-disable-next-line no-console
            console.error("NEXT: Enable writes with AUERNYX_WRITE_ENABLED=1 or set writeEnabled:true in config/auernyx.config.json");
        }
        // eslint-disable-next-line no-console
        console.error(lifecycle.refusal?.code ?? lifecycle.refusal?.reason ?? "refused");
        process.exit(3);
    }

    core.ledger.append(core.sessionId, "cli.intent", { input: raw, capability: lifecycle.capability, result: lifecycle.result });

    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ capability: lifecycle.capability, result: lifecycle.result, receipt: lifecycle.receipt }, null, 2));
}

main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(99);
});
