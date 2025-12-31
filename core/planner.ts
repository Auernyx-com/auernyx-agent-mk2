import * as crypto from "crypto";
import { CapabilityName, getCapabilityMeta } from "./policy";
import type { Router } from "./router";

export type EvidenceRequirement = {
    id: string;
    type: "user_assertion" | "pasted_text" | "file_hash" | "external_ref";
    description: string;
};

export type RollbackPoint = {
    id: string;
    description: string;
};

export type PlanTool = {
    kind: "capability";
    name: CapabilityName;
};

export type PlanStepType = "READ_ONLY" | "CONTROLLED_WRITE" | "HIGH_RISK";

export type PlanStep = {
    id: string;
    type: PlanStepType;
    tool: PlanTool;
    input?: unknown;
    requiredEvidence: EvidenceRequirement[];
    rollbackPointId?: string;
};

export type PlanRiskClass = "LOW" | "MEDIUM" | "HIGH";

export type Plan = {
    version: 2;

    // Deterministic identity.
    planId: string;
    intent: string;
    inputHash: string;

    riskClass: PlanRiskClass;
    tools: PlanTool[];
    requiredEvidence: EvidenceRequirement[];
    rollbackPoints: RollbackPoint[];
    steps: PlanStep[];
};

function sha256Hex(buf: Buffer | string): string {
    return crypto.createHash("sha256").update(buf).digest("hex");
}

function stableStringify(value: unknown): string {
    const seen = new WeakSet<object>();
    const normalize = (v: any): any => {
        if (v === null || v === undefined) return v;
        const t = typeof v;
        if (t === "number" || t === "boolean" || t === "string") return v;
        if (Array.isArray(v)) return v.map(normalize);
        if (t === "object") {
            if (seen.has(v)) throw new Error("circular_json");
            seen.add(v);
            const out: Record<string, any> = {};
            for (const k of Object.keys(v).sort()) {
                out[k] = normalize(v[k]);
            }
            return out;
        }
        // functions/symbols/etc are not representable deterministically
        return String(v);
    };
    return JSON.stringify(normalize(value));
}

function classifyStepType(meta: { readOnly: boolean; tier: number }): PlanStepType {
    if (meta.readOnly) return "READ_ONLY";
    if (meta.tier >= 2) return "HIGH_RISK";
    return "CONTROLLED_WRITE";
}

function classifyRisk(steps: PlanStep[]): PlanRiskClass {
    if (steps.some((s) => s.type === "HIGH_RISK")) return "HIGH";
    if (steps.some((s) => s.type === "CONTROLLED_WRITE")) return "MEDIUM";
    return "LOW";
}

export function planForIntent(router: Router, intent: string, input?: unknown): Plan {
    const capability = router.route({ raw: intent });
    if (!capability) {
        throw new Error("unroutable_intent");
    }

    // Canonical controlled write path: Search doc updates.
    // Step 1: preview (dry-run), Step 2: apply (requires APPLY confirm).
    if (capability === "searchDocApply" || capability === "searchDocPreview") {
        const previewTool: PlanTool = { kind: "capability", name: "searchDocPreview" };
        const applyTool: PlanTool = { kind: "capability", name: "searchDocApply" };

        const rollbackPoints: RollbackPoint[] = [
            {
                id: "rb-1",
                description:
                    "Rollback: restore docs/SEARCH.md to its previous content (use git restore, or use the receipt’s recorded before-hash as the reference)."
            }
        ];

        const requiredEvidence: EvidenceRequirement[] = [
            {
                id: "ev-1",
                type: "user_assertion",
                description: "Reviewer confirms the dry-run output matches intent and is safe to apply."
            }
        ];

        const steps: PlanStep[] = [
            {
                id: "step-1",
                type: "READ_ONLY",
                tool: previewTool,
                input,
                requiredEvidence: [],
            },
            {
                id: "step-2",
                type: "CONTROLLED_WRITE",
                tool: applyTool,
                input,
                requiredEvidence,
                rollbackPointId: rollbackPoints[0].id
            }
        ];

        const draft: Omit<Plan, "planId"> = {
            version: 2,
            intent,
            inputHash: sha256Hex(stableStringify(input ?? null)),
            riskClass: classifyRisk(steps),
            tools: [previewTool, applyTool],
            requiredEvidence,
            rollbackPoints,
            steps
        };

        const planId = sha256Hex(stableStringify(draft));
        return { ...draft, planId };
    }

    const meta = getCapabilityMeta(capability);
    const tool: PlanTool = { kind: "capability", name: capability };

    const stepType = classifyStepType(meta);

    const rollbackPoints: RollbackPoint[] = meta.readOnly
        ? []
        : [
              {
                  id: "rb-1",
                  description: "If this operation changes state, record a known-good snapshot beforehand and document rollback steps."
              }
          ];

    const steps: PlanStep[] = [
        {
            id: "step-1",
            type: stepType,
            tool,
            input,
            requiredEvidence: [],
            rollbackPointId: rollbackPoints.length ? rollbackPoints[0].id : undefined
        }
    ];

    const draft: Omit<Plan, "planId"> = {
        version: 2,
        intent,
        inputHash: sha256Hex(stableStringify(input ?? null)),
        riskClass: classifyRisk(steps),
        tools: [tool],
        requiredEvidence: [],
        rollbackPoints,
        steps
    };

    const planId = sha256Hex(stableStringify(draft));
    return { ...draft, planId };
}
