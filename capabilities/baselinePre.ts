import type { RouterContext } from "../core/router";
import { recordKnownGood } from "../core/knownGood";
import * as fs from "fs";
import * as path from "path";
import { getApproverIdentity, getKintsugiPolicy, policyHash, snapshotPolicyAndActivate } from "../core/kintsugi/memory";
import { recordKnownGoodSnapshot } from "../core/kintsugi/knownGood";

function readLedgerTailHash(repoRoot: string): string | undefined {
    const ledgerPath = path.join(repoRoot, "logs", "ledger.ndjson");
    if (!fs.existsSync(ledgerPath)) return undefined;
    const lines = fs.readFileSync(ledgerPath, "utf8").trim().split(/\r?\n/);
    const tail = lines.length ? lines[lines.length - 1] : undefined;
    if (!tail) return undefined;
    try {
        const parsed = JSON.parse(tail) as any;
        return typeof parsed?.hash === "string" ? parsed.hash : undefined;
    } catch {
        return undefined;
    }
}

export async function baselinePre(ctx: RouterContext, input?: unknown): Promise<unknown> {
    const reason = typeof (input as any)?.reason === "string" ? (input as any).reason : "baselinePre";
    const createdBy = typeof (input as any)?.createdBy === "string" ? (input as any).createdBy : "human";

    const entry = recordKnownGood(ctx.repoRoot, {
        createdBy,
        reason,
        ledgerHeadHash: readLedgerTailHash(ctx.repoRoot),
    });

    const policy = getKintsugiPolicy(ctx.repoRoot);
    const approvedBy = createdBy === "human" ? getApproverIdentity(ctx.repoRoot) : createdBy;
    const snap = await snapshotPolicyAndActivate(ctx.repoRoot, policy, {
        suggestionId: "baselinePre",
        reason,
        approvedBy,
        riskLevel: "SAFE",
        blastRadius: ["kintsugi-policy"],
    });

    const kintsugiEntry = await recordKnownGoodSnapshot(ctx.repoRoot, {
        policySnapshotPath: snap.snapshotPath,
        policyHash: policyHash(policy),
        approvedBy,
        reason,
    });

    return { entry, kintsugiEntry };
}
