// mondayInfractionReview — HIL disposition of open Feneris infractions
// Monday surfaces open infractions to the human, collects disposition decisions, and writes
// append-only aesir.governance.disposition.v1 records. Closes the Feneris HIL gap.

import type { RouterContext } from "../core/router";
import { loadConfig } from "../core/config";
import { readOpenInfractions } from "../core/feneris";
import {
    loadMondayPersona,
    loadMondayConfig,
    createMondayProvider,
    formatInfractionForHuman,
    recordHilDisposition,
    readDispositions,
    type DispositionDecision,
    type HilDispositionRecord
} from "../core/monday";

interface DispositionInput {
    infraction_id: string;
    decision: DispositionDecision;
    rationale: string;
}

interface MondayInfractionReviewInput {
    dispositions?: DispositionInput[];
}

const VALID_DECISIONS: DispositionDecision[] = ["confirmed", "closed", "false_positive", "waived"];

export async function mondayInfractionReview(ctx: RouterContext, input?: unknown): Promise<unknown> {
    const cfg = loadConfig(ctx.repoRoot);
    const persona = loadMondayPersona(ctx.repoRoot);
    const mondayConfig = loadMondayConfig(ctx.repoRoot);
    const provider = createMondayProvider(mondayConfig);
    void provider;

    const openInfractions = readOpenInfractions(ctx.repoRoot);

    if (openInfractions.length === 0) {
        return {
            monday: persona.member,
            status: "no_open_infractions",
            message: "No open infractions. System is clear.",
            dispositions_written: 0
        };
    }

    const reviewInput = input as MondayInfractionReviewInput | undefined;

    // Phase 1: no disposition input — surface infractions for human review
    if (!reviewInput?.dispositions || reviewInput.dispositions.length === 0) {
        return {
            monday: persona.member,
            status: "awaiting_disposition",
            open_count: openInfractions.length,
            infractions: openInfractions.map(inf => ({
                infraction_id: inf.infraction_id,
                rule_id: inf.rule_id,
                severity: inf.severity,
                summary: formatInfractionForHuman(inf, ctx.repoRoot)
            })),
            instructions: `${openInfractions.length} infraction(s) require HIL disposition. Resubmit with a 'dispositions' array. Each entry: { infraction_id, decision, rationale }. Valid decisions: confirmed | closed | false_positive | waived.`
        };
    }

    // Phase 2: disposition input received — validate and write records
    const existingDispositions = readDispositions(ctx.repoRoot);
    const alreadyDispositioned = new Set(existingDispositions.map(d => d.infraction_id));
    const openIds = new Set(openInfractions.map(inf => inf.infraction_id));

    const approverIdentity =
        cfg.governance.approverIdentity ||
        (ctx.approval as Record<string, unknown> | undefined)?.["identity"] as string ||
        "unknown";

    const written: HilDispositionRecord[] = [];
    const skipped: string[] = [];
    const invalid: string[] = [];

    for (const d of reviewInput.dispositions) {
        if (!d.infraction_id || typeof d.infraction_id !== "string") {
            invalid.push("entry missing infraction_id");
            continue;
        }
        if (!VALID_DECISIONS.includes(d.decision)) {
            invalid.push(`${d.infraction_id}: invalid decision "${d.decision}"`);
            continue;
        }
        if (!openIds.has(d.infraction_id)) {
            invalid.push(`${d.infraction_id}: not found in open infractions`);
            continue;
        }
        if (alreadyDispositioned.has(d.infraction_id)) {
            skipped.push(d.infraction_id);
            continue;
        }

        const record = recordHilDisposition(ctx.repoRoot, {
            infraction_id: d.infraction_id,
            decision: d.decision,
            rationale: d.rationale || "(no rationale provided)",
            assessed_by: approverIdentity
        });
        written.push(record);
    }

    return {
        monday: persona.member,
        status: "dispositions_written",
        dispositions_written: written.length,
        dispositions_skipped: skipped.length > 0 ? skipped : undefined,
        dispositions_invalid: invalid.length > 0 ? invalid : undefined,
        written: written.map(r => ({
            disposition_id: r.disposition_id,
            infraction_id: r.infraction_id,
            decision: r.decision,
            assessed_at: r.assessed_at
        })),
        remaining_open: openInfractions.length - written.length
    };
}
