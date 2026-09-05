import type { RouterContext } from "../core/router";
import { runSentinelScan, type FenerisScanReport } from "../core/feneris";
import { loadConfig } from "../core/config";

export async function fenerisPrep(ctx: RouterContext, _input?: unknown): Promise<FenerisScanReport> {
    const cfg = loadConfig(ctx.repoRoot);
    return runSentinelScan(ctx.repoRoot, ctx.sessionId, { writeEnabled: cfg.writeEnabled });
}
