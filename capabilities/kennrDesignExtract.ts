import type { RouterContext } from "../core/router";

const KENNR_WORKER_URL = "https://kennr-worker.justinaiark101.workers.dev";

interface KennrExtractInput {
    url?: string;
    html?: string;
    label?: string;
}

interface KennrExtractResult {
    approved: boolean;
    extraction?: unknown;
    reasoning: string;
    hil_gate: {
        status: "BYPASSED_POC";
        note: string;
    };
}

const HIL_GATE = {
    status: "BYPASSED_POC" as const,
    note: "LIVE_SYSTEM_WOULD_PAUSE_HERE: human operator approval required before outbound extraction",
};

export async function kennrDesignExtract(ctx: RouterContext, input?: unknown): Promise<KennrExtractResult> {
    const data = input as KennrExtractInput;

    if (!data || (!data.url && !data.html)) {
        return {
            approved: false,
            reasoning: "REFUSED: url or html required",
            hil_gate: HIL_GATE,
        };
    }

    ctx.ledger?.append(ctx.sessionId, "kennr.extract.start", {
        label: data.label ?? null,
        mode: data.url ? "url" : "html",
        target: data.url ?? "(html supplied)",
    });

    const endpoint = data.url
        ? `${KENNR_WORKER_URL}/api/extract/url`
        : `${KENNR_WORKER_URL}/api/extract/html`;

    const body = data.url
        ? { url: data.url, label: data.label }
        : { html: data.html, label: data.label };

    let extraction: unknown;
    try {
        const res = await fetch(endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        });
        if (!res.ok) {
            const detail = await res.text().catch(() => res.statusText);
            throw new Error(`Kennr worker returned ${res.status}: ${detail}`);
        }
        extraction = await res.json();
    } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        ctx.ledger?.append(ctx.sessionId, "kennr.extract.error", { error: msg });
        return {
            approved: false,
            reasoning: `FAILED: ${msg}`,
            hil_gate: HIL_GATE,
        };
    }

    ctx.ledger?.append(ctx.sessionId, "kennr.extract.complete", {
        label: data.label ?? null,
        mode: data.url ? "url" : "html",
    });

    return {
        approved: true,
        extraction,
        reasoning: `Extraction complete — label: ${data.label ?? "(unlabeled)"}`,
        hil_gate: HIL_GATE,
    };
}
