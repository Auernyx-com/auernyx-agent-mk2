import type { RouterContext } from "../core/router";
import { verifyLedgerIntegrity } from "../core/integrity";

export async function baselinePost(ctx: RouterContext, _input?: unknown): Promise<unknown> {
    const integrity = verifyLedgerIntegrity(ctx.repoRoot);
    return { ok: integrity.ok, warnings: integrity.warnings, checkedEntries: integrity.checkedEntries };
}
