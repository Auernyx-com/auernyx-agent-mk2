import type { RouterContext } from "../core/router";
import { getSkjoldrFirewallStatus, parseSkjoldrJson, runSkjoldrCommand } from "../core/skjoldrFirewall";

export async function skjoldrFirewallStatus(ctx: RouterContext, _input?: unknown): Promise<unknown> {
    const status = getSkjoldrFirewallStatus(ctx.repoRoot, { allowAutoDetect: true });

    if (!status.enabled) {
        return { ok: true, enabled: false, available: false, notes: status.notes };
    }
    if (!status.available || !status.resolvedCommand) {
        return { ok: false, enabled: true, available: false, notes: status.notes };
    }

    const args = [...(status.statusArgs ?? [])];
    if (status.json) args.push("--json");
    if (Number.isFinite(status.timeoutMs) && status.timeoutMs > 0) args.push("--timeout", String(status.timeoutMs));

    const result = await runSkjoldrCommand(status.resolvedCommand, args, status.timeoutMs);

    let env: unknown = undefined;
    if (status.json) {
        env = parseSkjoldrJson(result.stdout);
    }

    return {
        ok: status.json ? (env as any)?.ok === true : result.exitCode === 0,
        enabled: true,
        available: true,
        command: status.resolvedCommand,
        args,
        exitCode: result.exitCode,
        stderr: result.stderr?.trim() || undefined,
        stdout: status.json ? undefined : result.stdout?.trim() || undefined,
        json: env,
    };
}
