import type { RouterContext } from "../core/router";

const SKADI_WORKER_URL = "https://skadi.justinaiark101.workers.dev";

const MARKETS = [
    "Grand Junction", "Montrose", "Delta", "Glenwood Springs",
    "Rifle", "Fruita", "Palisade",
];

interface SkadiLeadScanInput {
    market?: number; // 0–6 index; omit to use current day rotation
}

interface SkadiLeadScanResult {
    approved: boolean;
    market?: string;
    scan?: unknown;
    reasoning: string;
    hil_gate: {
        status: "BYPASSED_POC";
        note: string;
    };
}

const HIL_GATE = {
    status: "BYPASSED_POC" as const,
    note: "LIVE_SYSTEM_WOULD_PAUSE_HERE: human operator approval required before outbound lead scan",
};

export async function skadiLeadScan(ctx: RouterContext, input?: unknown): Promise<SkadiLeadScanResult> {
    const data = (input ?? {}) as SkadiLeadScanInput;

    const marketIdx = typeof data.market === "number"
        ? Math.max(0, Math.min(6, data.market))
        : new Date().getDay() % MARKETS.length;

    const marketName = MARKETS[marketIdx];

    ctx.ledger?.append(ctx.sessionId, "skadi.lead-scan.start", {
        market_idx: marketIdx,
        market: marketName,
    });

    let scan: unknown;
    try {
        const res = await fetch(`${SKADI_WORKER_URL}/hunt`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ market: marketIdx }),
        });
        if (!res.ok) {
            const detail = await res.text().catch(() => res.statusText);
            throw new Error(`Skadi worker returned ${res.status}: ${detail}`);
        }
        scan = await res.json();
    } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        ctx.ledger?.append(ctx.sessionId, "skadi.lead-scan.error", { market: marketName, error: msg });
        return {
            approved: false,
            market: marketName,
            reasoning: `FAILED: ${msg}`,
            hil_gate: HIL_GATE,
        };
    }

    ctx.ledger?.append(ctx.sessionId, "skadi.lead-scan.complete", {
        market_idx: marketIdx,
        market: marketName,
    });

    return {
        approved: true,
        market: marketName,
        scan,
        reasoning: `Lead scan complete — market: ${marketName}`,
        hil_gate: HIL_GATE,
    };
}
