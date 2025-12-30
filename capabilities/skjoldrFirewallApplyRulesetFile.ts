import type { RouterContext } from "../core/router";
import * as fs from "fs";
import { getSkjoldrFirewallStatus, runSkjoldrJsonCommand } from "../core/skjoldrFirewall";

export interface SkjoldrApplyRulesetFileInput {
    rulesetPath: string;
}

export async function skjoldrFirewallApplyRulesetFile(ctx: RouterContext, input?: unknown): Promise<unknown> {
    const status = getSkjoldrFirewallStatus(ctx.repoRoot, { allowAutoDetect: false });
    if (!status.enabled) throw new Error("Skjoldr Firewall add-on is disabled.");
    if (!status.available || !status.resolvedCommand) throw new Error("Skjoldr command not configured/resolved.");
    if (!status.json) throw new Error("Refusing to apply firewall changes without JSON mode.");

    const rulesetPath = String((input as any)?.rulesetPath ?? "").trim();
    if (!rulesetPath) throw new Error("Input.rulesetPath is required");
    if (!fs.existsSync(rulesetPath)) throw new Error(`Ruleset file not found: ${rulesetPath}`);

    const common = ["--json", "--timeout", String(status.timeoutMs)];

    const preExport = await runSkjoldrJsonCommand(status.resolvedCommand, ["export", ...common], status.timeoutMs);
    const dryRun = await runSkjoldrJsonCommand(
        status.resolvedCommand,
        ["apply", "--file", rulesetPath, "--dry-run", ...common],
        status.timeoutMs
    );

    if (!preExport.ok) throw new Error("Skjoldr export returned ok=false");
    if (!dryRun.ok) throw new Error("Skjoldr dry-run returned ok=false");

    const applied = await runSkjoldrJsonCommand(status.resolvedCommand, ["apply", "--file", rulesetPath, ...common], status.timeoutMs);
    const postStatus = await runSkjoldrJsonCommand(status.resolvedCommand, ["status", ...common], status.timeoutMs);

    if (!applied.ok || !postStatus.ok) throw new Error("Skjoldr apply returned ok=false");

    return { ok: true, rulesetPath, preExport, dryRun, applied, postStatus };
}
