import type { RouterContext } from "../core/router";
import { getSkjoldrFirewallStatus, runSkjoldrJsonCommand, verifyBaselineSnapshot } from "../core/skjoldrFirewall";

export async function skjoldrFirewallRestoreBaseline(ctx: RouterContext, input?: unknown): Promise<unknown> {
    const status = getSkjoldrFirewallStatus(ctx.repoRoot, { allowAutoDetect: false });
    if (!status.enabled) throw new Error("Skjoldr Firewall add-on is disabled.");
    if (!status.available || !status.resolvedCommand) throw new Error("Skjoldr command not configured/resolved.");
    if (!status.json) throw new Error("Refusing to restore baseline without JSON mode.");

    const baselineSnapshotPath = String((input as any)?.baselineSnapshotPath ?? status.baselineSnapshotPath ?? "").trim();
    const baselineSnapshotHash = String((input as any)?.baselineSnapshotHash ?? status.baselineSnapshotHash ?? "").trim();

    if (!baselineSnapshotPath) throw new Error("baselineSnapshotPath is required (config or input)");
    if (!baselineSnapshotHash) throw new Error("baselineSnapshotHash is required (config or input)");

    const verified = verifyBaselineSnapshot(baselineSnapshotPath, baselineSnapshotHash);
    if (!verified.ok) throw new Error(`Baseline verification failed: ${verified.error}`);

    const common = ["--json", "--timeout", String(status.timeoutMs)];

    const pre = await runSkjoldrJsonCommand(status.resolvedCommand, ["export", ...common], status.timeoutMs);
    const restored = await runSkjoldrJsonCommand(
        status.resolvedCommand,
        ["restore", "--snapshot", baselineSnapshotPath, ...common],
        status.timeoutMs
    );
    const postStatus = await runSkjoldrJsonCommand(status.resolvedCommand, ["status", ...common], status.timeoutMs);

    if (!pre.ok || !restored.ok || !postStatus.ok) throw new Error("Skjoldr restore flow returned ok=false");

    return { ok: true, baselineSnapshotPath, baselineSnapshotHash, pre, restored, postStatus };
}
