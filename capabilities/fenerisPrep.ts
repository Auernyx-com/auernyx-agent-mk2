import type { RouterContext } from "../core/router";
import { runSentinelScan, type FenerisScanReport } from "../core/feneris";

export async function fenerisPrep(ctx: RouterContext, _input?: unknown): Promise<FenerisScanReport> {
    return runSentinelScan(ctx.repoRoot, ctx.sessionId);
}
