import type { RouterContext } from "../core/router";

const KENNR_WORKER_URL = "https://kennr-worker.justinaiark101.workers.dev";

interface KennrDnaSynthesizeInput {
    extraction_ids: string[];
    project_name?: string;
}

interface KennrDnaSynthesizeResult {
    approved: boolean;
    dna?: unknown;
    reasoning: string;
    hil_gate: {
        status: "BYPASSED_POC";
        note: string;
    };
}

const HIL_GATE = {
    status: "BYPASSED_POC" as const,
    note: "LIVE_SYSTEM_WOULD_PAUSE_HERE: human operator approval required before DNA synthesis write",
};

export async function kennrDesignDnaSynthesize(ctx: RouterContext, input?: unknown): Promise<KennrDnaSynthesizeResult> {
    const data = input as KennrDnaSynthesizeInput;

    if (!data || !Array.isArray(data.extraction_ids) || data.extraction_ids.length === 0) {
        return {
            approved: false,
            reasoning: "REFUSED: extraction_ids array required (non-empty)",
            hil_gate: HIL_GATE,
        };
    }

    ctx.ledger?.append(ctx.sessionId, "kennr.dna.synthesize.start", {
        project_name: data.project_name ?? null,
        extraction_count: data.extraction_ids.length,
    });

    let dna: unknown;
    try {
        const res = await fetch(`${KENNR_WORKER_URL}/api/analyze/dna`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                extraction_ids: data.extraction_ids,
                project_name: data.project_name,
            }),
        });
        if (!res.ok) {
            const detail = await res.text().catch(() => res.statusText);
            throw new Error(`Kennr worker returned ${res.status}: ${detail}`);
        }
        dna = await res.json();
    } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        ctx.ledger?.append(ctx.sessionId, "kennr.dna.synthesize.error", { error: msg });
        return {
            approved: false,
            reasoning: `FAILED: ${msg}`,
            hil_gate: HIL_GATE,
        };
    }

    ctx.ledger?.append(ctx.sessionId, "kennr.dna.synthesize.complete", {
        project_name: data.project_name ?? null,
    });

    return {
        approved: true,
        dna,
        reasoning: `DNA synthesis complete — project: ${data.project_name ?? "(untitled)"}`,
        hil_gate: HIL_GATE,
    };
}
