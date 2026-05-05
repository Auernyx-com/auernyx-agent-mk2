// mondaySystemStatus — Monday-voiced full governance state surface
// Surfaces governance lock, Obsidian's Judgment, and open infraction count in one call.
// Read-only. The human gets the complete picture of what the system is blocking on and why.

import type { RouterContext } from "../core/router";
import {
    loadMondayPersona,
    formatGovernanceLockForHuman,
    formatJudgmentForHuman
} from "../core/monday";
import { readGovernanceLock } from "../core/governanceLock";
import { readJudgment } from "../core/provenance";
import { readOpenInfractions } from "../core/feneris";

export async function mondaySystemStatus(ctx: RouterContext, _input?: unknown): Promise<unknown> {
    const persona = loadMondayPersona(ctx.repoRoot);
    const lock = readGovernanceLock(ctx.repoRoot);
    const judgment = readJudgment(ctx.repoRoot);
    const openInfractions = readOpenInfractions(ctx.repoRoot);

    const alerts: string[] = [];
    if (judgment?.active) alerts.push("OBSIDIAN_JUDGMENT");
    if (lock.locked) alerts.push("GOVERNANCE_LOCK");
    if (openInfractions.length > 0) alerts.push(`OPEN_INFRACTIONS(${openInfractions.length})`);

    const sections: Record<string, unknown> = {
        monday: persona.member,
        status: alerts.length === 0 ? "CLEAR" : "ATTENTION_REQUIRED",
        alerts
    };

    sections["obsidian_judgment"] = judgment?.active
        ? { active: true, activated_at: judgment.activated_at, failure_code: judgment.failure.code, human_readable: formatJudgmentForHuman(judgment, ctx.repoRoot) }
        : { active: false };

    sections["governance_lock"] = lock.locked
        ? { active: true, reason: lock.reason ?? "(no reason recorded)", human_readable: formatGovernanceLockForHuman(lock, ctx.repoRoot) }
        : { active: false };

    sections["open_infractions"] = {
        count: openInfractions.length,
        ids: openInfractions.map(i => i.infraction_id)
    };

    sections["message"] = alerts.length === 0
        ? `${persona.member}: System is clear. No active judgment, no active lock, no open infractions.`
        : `${persona.member}: ${alerts.length} alert(s) require attention. Review details above.`;

    return sections;
}
