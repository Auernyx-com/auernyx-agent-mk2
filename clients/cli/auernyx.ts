#!/usr/bin/env node

import { createCore } from "../../core/server";
import { tryRunViaDaemon } from "../../core/daemonClient";
import { createHumanApproval } from "../../core/approvals";
import { capabilityRequiresApproval, CapabilityName } from "../../core/policy";
import { loadConfig } from "../../core/config";
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
            "  auernyx skjoldr restore-baseline [--snapshot <FILE>] [--hash <SHA256>]"
        ].join("\n")
    );
    process.exit(1);
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

function buildStructuredInput(argv: string[]): { daemonInput: unknown; daemonIntent: string; controlled: boolean } {
    if (argv.length === 0) usageAndExit();

    const primary = (argv[0] ?? "").toLowerCase();

    // Default: no structured input, pass through raw intent.
    let daemonIntent = argv.join(" ").trim();
    let daemonInput: unknown = undefined;
    let controlled = false;

    if (primary === "scan") {
        if (typeof argv[1] === "string") daemonInput = { targetDir: argv[1] };
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

    // Try daemon first.
    let daemonResp = await tryRunViaDaemon({ repoRoot }, daemonIntent, daemonInput);
    if (daemonResp !== null) {
        if (!daemonResp.ok && daemonResp.error === "approval_required") {
            const cap = daemonResp.capability ?? "capability";
            const reason = await promptApproval(cap);
            if (!reason) process.exit(4);
            const identity = identityRequired
                ? (await promptText(`Approver identity required. Type identity (expected: ${cfg.governance.approverIdentity}): `))
                : null;
            if (identityRequired && (!identity || identity.trim().length === 0)) process.exit(4);

            const confirm = controlled ? (await promptText("Controlled operation. Type APPLY to continue: ")) : null;
            if (controlled && confirm !== "APPLY") process.exit(4);

            const approval = createHumanApproval(reason, {
                identity: identity ?? undefined,
                confirm: controlled ? "APPLY" : undefined
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

    let approval = undefined;
    if (capabilityRequiresApproval(capability as CapabilityName)) {
        const reason = await promptApproval(capability);
        if (!reason) process.exit(4);
        const identity = identityRequired
            ? (await promptText(`Approver identity required. Type identity (expected: ${cfg.governance.approverIdentity}): `))
            : null;
        if (identityRequired && (!identity || identity.trim().length === 0)) process.exit(4);

        const confirm = controlled ? (await promptText("Controlled operation. Type APPLY to continue: ")) : null;
        if (controlled && confirm !== "APPLY") process.exit(4);

        approval = createHumanApproval(reason, {
            identity: identity ?? undefined,
            confirm: controlled ? "APPLY" : undefined
        });
    }

    const result = await core.router.run(capability, { repoRoot, sessionId: core.sessionId, ledger: core.ledger }, localInput, approval);
    core.ledger.append(core.sessionId, "cli.intent", { input: raw, capability, result });

    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ capability, result }, null, 2));
}

main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(99);
});
