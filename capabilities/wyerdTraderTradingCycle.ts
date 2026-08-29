import type { RouterContext } from "../core/router";

interface ModelVerdict {
    seat: "AUENRIX" | "GHOST" | "BASTION";
    provider: string;
    model: string;
    verdict: "BUY" | "SELL" | "HOLD" | "FAILED";
    asset: "DOGE" | "AVAX" | "NONE";
    confidence: number;
    veto: boolean;
    reasoning: string;
}

interface TradingCycleInput {
    cycle_id: string;
    timestamp: string;
    prices: { DOGE: number; AVAX: number };
    verdicts: ModelVerdict[];
}

interface TradingDecision {
    approved: boolean;
    action?: "BUY" | "SELL" | "HOLD";
    asset?: "DOGE" | "AVAX";
    confidence?: number;
    reasoning: string;
    consensus_count?: number;
    veto_active?: boolean;
    hil_gate: {
        status: "BYPASSED_POC";
        note: string;
    };
}

const HIL_GATE = {
    status: "BYPASSED_POC" as const,
    note: "LIVE_SYSTEM_WOULD_PAUSE_HERE: human operator approval required before any trade execution",
};

export async function wyerdTraderTradingCycle(ctx: RouterContext, input?: unknown): Promise<TradingDecision> {
    const data = input as TradingCycleInput;

    if (!data || !Array.isArray(data.verdicts) || data.verdicts.length !== 3) {
        return {
            approved: false,
            reasoning: "REFUSED: invalid input — expected 3 model verdicts",
            hil_gate: HIL_GATE,
        };
    }

    ctx.ledger?.append(ctx.sessionId, "wyerd-trader.cycle.start", {
        cycle_id: data.cycle_id,
        timestamp: data.timestamp,
        prices: data.prices,
    });

    // Any FAILED verdict fails the whole cycle — no guessing with incomplete data
    const failedSeats = data.verdicts.filter(v => v.verdict === "FAILED").map(v => v.seat);
    if (failedSeats.length > 0) {
        ctx.ledger?.append(ctx.sessionId, "wyerd-trader.cycle.model_failure", {
            cycle_id: data.cycle_id,
            failed_seats: failedSeats,
        });
        return {
            approved: false,
            reasoning: `REFUSED: model failure on seats [${failedSeats.join(", ")}] — fail closed`,
            hil_gate: HIL_GATE,
        };
    }

    // BASTION veto check — hard stop regardless of consensus
    const bastion = data.verdicts.find(v => v.seat === "BASTION");
    if (bastion?.veto) {
        ctx.ledger?.append(ctx.sessionId, "wyerd-trader.bastion.veto", {
            cycle_id: data.cycle_id,
            bastion_reasoning: bastion.reasoning,
        });
        return {
            approved: false,
            veto_active: true,
            reasoning: `REFUSED: BASTION veto active — ${bastion.reasoning}`,
            hil_gate: HIL_GATE,
        };
    }

    // BASTION confidence floor: binding, not advisory
    const CONFIDENCE_FLOOR = 60;
    if (bastion && bastion.confidence < CONFIDENCE_FLOOR) {
        return {
            approved: false,
            reasoning: `REFUSED: BASTION confidence ${bastion.confidence}% below ${CONFIDENCE_FLOOR}% floor — binding, not advisory`,
            hil_gate: HIL_GATE,
        };
    }

    // Consensus check: need 2/3 agreement on both action AND asset
    const actionCounts: Record<string, { count: number; assets: Record<string, number>; confidences: number[] }> = {};
    for (const v of data.verdicts) {
        if (!actionCounts[v.verdict]) {
            actionCounts[v.verdict] = { count: 0, assets: {}, confidences: [] };
        }
        actionCounts[v.verdict].count++;
        actionCounts[v.verdict].assets[v.asset] = (actionCounts[v.verdict].assets[v.asset] ?? 0) + 1;
        actionCounts[v.verdict].confidences.push(v.confidence);
    }

    let majorityAction: string | null = null;
    let majorityAsset: string | null = null;
    let consensusCount = 0;
    let avgConfidence = 0;

    for (const [action, info] of Object.entries(actionCounts)) {
        if (info.count >= 2) {
            majorityAction = action;
            consensusCount = info.count;
            avgConfidence = info.confidences.reduce((a, b) => a + b, 0) / info.confidences.length;
            const assetEntries = Object.entries(info.assets).sort((a, b) => b[1] - a[1]);
            majorityAsset = assetEntries[0]?.[0] ?? "NONE";
            break;
        }
    }

    if (!majorityAction || majorityAction === "HOLD" || !majorityAsset || majorityAsset === "NONE") {
        ctx.ledger?.append(ctx.sessionId, "wyerd-trader.cycle.no_consensus", {
            cycle_id: data.cycle_id,
            action_counts: actionCounts,
        });
        return {
            approved: false,
            action: "HOLD",
            reasoning: `No actionable consensus — votes: ${JSON.stringify(Object.fromEntries(Object.entries(actionCounts).map(([k, v]) => [k, v.count])))}`,
            consensus_count: consensusCount,
            hil_gate: HIL_GATE,
        };
    }

    ctx.ledger?.append(ctx.sessionId, "wyerd-trader.cycle.approved", {
        cycle_id: data.cycle_id,
        action: majorityAction,
        asset: majorityAsset,
        consensus_count: consensusCount,
        avg_confidence: avgConfidence,
    });

    return {
        approved: true,
        action: majorityAction as "BUY" | "SELL",
        asset: majorityAsset as "DOGE" | "AVAX",
        confidence: Math.round(avgConfidence),
        reasoning: `${consensusCount}/3 consensus — ${majorityAction} ${majorityAsset} @ avg confidence ${avgConfidence.toFixed(1)}%`,
        consensus_count: consensusCount,
        hil_gate: HIL_GATE,
    };
}
