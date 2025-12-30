import type { RouterContext } from "../core/router";
import { getSkjoldrFirewallStatus, runSkjoldrJsonCommand } from "../core/skjoldrFirewall";

export interface SkjoldrApplyProfileInput {
    profile: string;
}

export async function skjoldrFirewallApplyProfile(ctx: RouterContext, input?: unknown): Promise<unknown> {
    const status = getSkjoldrFirewallStatus(ctx.repoRoot, { allowAutoDetect: false });
    if (!status.enabled) throw new Error("Skjoldr Firewall add-on is disabled.");
    if (!status.available || !status.resolvedCommand) throw new Error("Skjoldr command not configured/resolved.");
    if (!status.json) throw new Error("Refusing to apply firewall changes without JSON mode.");

    const profile = String((input as any)?.profile ?? "").trim();
    if (!profile) throw new Error("Input.profile is required");

    const common = ["--json", "--timeout", String(status.timeoutMs)];

    // Preflight dry-run first.
    const preExport = await runSkjoldrJsonCommand(status.resolvedCommand, ["export", ...common], status.timeoutMs);
    const dryRun = await runSkjoldrJsonCommand(
        status.resolvedCommand,
        ["apply", "--profile", profile, "--dry-run", ...common],
        status.timeoutMs
    );

    if (!preExport.ok) throw new Error("Skjoldr export returned ok=false");
    if (!dryRun.ok) throw new Error("Skjoldr dry-run returned ok=false");

    // Governed apply.
    const applied = await runSkjoldrJsonCommand(status.resolvedCommand, ["apply", "--profile", profile, ...common], status.timeoutMs);
    const postStatus = await runSkjoldrJsonCommand(status.resolvedCommand, ["status", ...common], status.timeoutMs);

    if (!applied.ok || !postStatus.ok) throw new Error("Skjoldr apply returned ok=false");

    return { ok: true, profile, preExport, dryRun, applied, postStatus };
}
