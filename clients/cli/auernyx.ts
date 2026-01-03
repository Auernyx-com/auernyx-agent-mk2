#!/usr/bin/env node

import { createCore } from "../../core/server";
import { tryRunViaDaemon } from "../../core/daemonClient";
import { createHumanApproval } from "../../core/approvals";
import { capabilityRequiresApproval, CapabilityName, getCapabilityMeta } from "../../core/policy";
import { runLifecycle } from "../../core/runLifecycle";
import { loadConfig } from "../../core/config";
import { planForIntent } from "../../core/planner";
import * as readline from "readline";

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
            "  --confirm APPLY         Required for mutating operations",
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
    confirm?: "APPLY";
} {
    const reason = parseStringFlag(argv, "--reason") ?? parseStringFlag(argv, "--approve-reason");
    const identity = parseStringFlag(argv, "--identity");
    const confirmRaw = parseStringFlag(argv, "--confirm");
    const confirm = confirmRaw === "APPLY" ? "APPLY" : undefined;
    return {
        nonInteractive: typeof reason === "string" && reason.trim().length > 0,
        reason: typeof reason === "string" ? reason.trim() : undefined,
        identity: typeof identity === "string" ? identity.trim() : undefined,
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
    const identityRequired = cfg.governance.approverIdentity.trim().length > 0;

    // Try daemon first (unless explicitly disabled).
    let daemonResp = noDaemon ? null : await tryRunViaDaemon({ repoRoot }, daemonIntent, daemonInput);
    if (daemonResp !== null) {
        if (!daemonResp.ok && (daemonResp.error === "approval_required" || daemonResp.error === "step_approval_required")) {
            const cap = daemonResp.capability ?? "capability";
            const reason = approvalFlags.nonInteractive ? approvalFlags.reason! : await promptApproval(cap);
            if (!reason) process.exit(4);

            const identity = identityRequired
                ? (approvalFlags.nonInteractive ? approvalFlags.identity : await promptText(`Approver identity required. Type identity (expected: ${cfg.governance.approverIdentity}): `))
                : null;
            if (identityRequired && (!identity || identity.trim().length === 0)) process.exit(4);

            // Confirm is required for any non-readOnly capability, even via daemon.
            const capName = (typeof daemonResp.capability === "string" ? daemonResp.capability : undefined) as CapabilityName | undefined;
            const meta = capName ? getCapabilityMeta(capName) : undefined;
            const effectiveControlled = controlled || (meta ? !meta.readOnly : false);

            const confirm = effectiveControlled
                ? (approvalFlags.nonInteractive ? approvalFlags.confirm : await promptText("Controlled operation. Type APPLY to continue: "))
                : null;
            if (effectiveControlled && confirm !== "APPLY") process.exit(4);

            const approval = createHumanApproval(reason, {
                identity: identity ?? undefined,
                confirm: effectiveControlled ? "APPLY" : undefined
            });
            const retry = await tryRunViaDaemon({ repoRoot }, daemonIntent, daemonInput, approval);
            if (retry === null) {
                // daemon disappeared mid-flight; fall through to local
                daemonResp = null;
            } else {
                daemonResp = retry;
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

    // Governed execution requires step approvals. Use a single prompt (or --reason) and map it to each planned step.
    const reason = approvalFlags.nonInteractive ? approvalFlags.reason! : await promptApproval(capability);
    if (!reason) process.exit(4);

    const identity = identityRequired
        ? (approvalFlags.nonInteractive ? approvalFlags.identity : await promptText(`Approver identity required. Type identity (expected: ${cfg.governance.approverIdentity}): `))
        : null;
    if (identityRequired && (!identity || identity.trim().length === 0)) process.exit(4);

    const confirm = effectiveControlled
        ? (approvalFlags.nonInteractive ? approvalFlags.confirm : await promptText("Controlled operation. Type APPLY to continue: "))
        : null;
    if (effectiveControlled && confirm !== "APPLY") process.exit(4);

    const approval = createHumanApproval(reason, {
        identity: identity ?? undefined,
        confirm: effectiveControlled ? "APPLY" : undefined
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
