import type { RouterContext } from "../core/router";
import { GovernanceRefusalError } from "../core/governanceRefusal";

export async function fenerisPrep(_ctx: RouterContext, _input?: unknown): Promise<never> {
    throw new GovernanceRefusalError({
        system: "fenerisPrep",
        requestedAction: "fenerisPrep",
        refusalReason: "BRANCH_NOT_CONNECTED",
        policyRefs: ["capabilities.fenerisPrep"],
        riskLevel: "HIGH",
        whatWouldBeRequired: "Design and implement the Feneris watchdog branch: log watching, early compromise warning, and dangerous/misleading code flagging",
        notes: "Feneris branch attachment point is declared. No watchdog module is connected. No operation was performed.",
    });
}
