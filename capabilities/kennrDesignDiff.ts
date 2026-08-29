import type { RouterContext } from "../core/router";

const KENNR_WORKER_URL = "https://kennr-worker.justinaiark101.workers.dev";

interface KennrDesignDiffInput {
    dna_a_id: string;
    dna_b_id: string;
}

interface KennrDesignDiffResult {
    approved: boolean;
    diff?: unknown;
    reasoning: string;
    hil_gate: {
        status: "BYPASSED_POC";
        note: string;
    };
}

const HIL_GATE = {
    status: "BYPASSED_POC" as const,
    note: "LIVE_SYSTEM_WOULD_PAUSE_HERE: human operator approval required before DNA diff",
};

export async function kennrDesignDiff(ctx: RouterContext, input?: unknown): Promise<KennrDesignDiffResult> {
    const data = input as KennrDesignDiffInput;

    if (!data || !data.dna_a_id || !data.dna_b_id) {
        return {
            approved: false,
            reasoning: "REFUSED: dna_a_id and dna_b_id required",
            hil_gate: HIL_GATE,
        };
    }

    ctx.ledger?.append(ctx.sessionId, "kennr.dna.diff.start", {
        dna_a_id: data.dna_a_id,
        dna_b_id: data.dna_b_id,
    });

    let diff: unknown;
    try {
        const res = await fetch(`${KENNR_WORKER_URL}/api/dna/diff`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ dna_a_id: data.dna_a_id, dna_b_id: data.dna_b_id }),
        });
        if (!res.ok) {
            const detail = await res.text().catch(() => res.statusText);
            throw new Error(`Kennr worker returned ${res.status}: ${detail}`);
        }
        diff = await res.json();
    } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        ctx.ledger?.append(ctx.sessionId, "kennr.dna.diff.error", { error: msg });
        return {
            approved: false,
            reasoning: `FAILED: ${msg}`,
            hil_gate: HIL_GATE,
        };
    }

    ctx.ledger?.append(ctx.sessionId, "kennr.dna.diff.complete", {
        dna_a_id: data.dna_a_id,
        dna_b_id: data.dna_b_id,
    });

    return {
        approved: true,
        diff,
        reasoning: `DNA diff complete — comparing ${data.dna_a_id} vs ${data.dna_b_id}`,
        hil_gate: HIL_GATE,
    };
}
