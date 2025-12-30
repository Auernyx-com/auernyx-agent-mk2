import type { RouterContext } from "../core/router";

export async function docker(_ctx: RouterContext, _input?: unknown): Promise<{ ok: true }> {
    return { ok: true };
}
