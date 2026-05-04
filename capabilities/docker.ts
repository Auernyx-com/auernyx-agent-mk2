import type { RouterContext } from "../core/router";
import { GovernanceRefusalError } from "../core/governanceRefusal";

export async function docker(_ctx: RouterContext, _input?: unknown): Promise<never> {
    throw new GovernanceRefusalError({
        system: "docker",
        requestedAction: "docker",
        refusalReason: "BRANCH_NOT_CONNECTED",
        policyRefs: ["capabilities.docker"],
        riskLevel: "HIGH",
        whatWouldBeRequired: "Implement a Docker integration module and wire it into this capability",
        notes: "Docker branch attachment point is declared. No branch module is connected. No operation was performed.",
    });
}
