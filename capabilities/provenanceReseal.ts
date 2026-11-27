import type { RouterContext } from "../core/router";
import { approvalIdentity } from "../core/approvals";
import { sha256Hex, stableStringify } from "../core/crypto";
import { verifyLedgerIntegrity } from "../core/integrity";
import { runSelfTestChecks } from "../core/selfTestChecks";
import { makeMfr, makeSnapshotHash, recordFailure } from "../core/kintsugi/memory";
import { appendSealRecord, clearJudgment, planReseal, verifyProvenance } from "../core/provenance";
import { describeChanges } from "../core/sealedCopy";

// provenanceReseal (2026-11-27, Justin's decisions): the recorded way to
// accept a governance config change on a sealed install, and to recover from
// damage to the seal itself, without wiping audit history or hand-writing
// genesis.json.
//
// Without { apply: true } it only previews: why Obsidian's Judgment tripped,
// what changed in each sealed file (against the sealed copy), and the
// governance hash of the config as it is now. Nothing is written.
//
// With { apply: true, governanceHash } it re-seals, after the same bar as
// governanceUnlock: typed APPLY, the approver named in the SEAL (never the
// edited config, so nobody approves a config that names themselves), the audit
// ledger, and every self-test check. The hash must be the one the preview
// showed: the state reviewed is the state sealed.
//
// It is the 4th recovery capability: the router lets it run under Judgment,
// the governance lock and Kintsugi FAILED_CLOSED. It never clears the lock or
// FAILED_CLOSED; governanceUnlock stays the only way out of those.
//
// Limit: the seal and these approvals are plain hashes and plain-text
// identities with no key. This gives a legitimate change a record; it does not
// stop someone with file access from forging one. Signed approvals are the
// real fix (to-do).

type ProvenanceResealInput = { apply?: boolean; governanceHash?: string };

export async function provenanceReseal(ctx: RouterContext, input?: unknown): Promise<unknown> {
    const parsed = (input ?? {}) as Partial<ProvenanceResealInput>;
    const plan = planReseal(ctx.repoRoot);

    if (plan.state === "intact") {
        return {
            ok: true,
            nothingToReseal: true,
            message: "Provenance verifies: the config matches the seal in force. Nothing to re-seal.",
        };
    }

    if (plan.state === "not_sealed") {
        return {
            ok: false,
            error: "NOT_SEALED",
            failure: { code: plan.failure.code, reason: plan.failure.reason },
            whatWouldBeRequired:
                "This install was never sealed. The first run with writes enabled (AUERNYX_WRITE_ENABLED=1) seals it; " +
                "re-seal is only for an install that was already sealed.",
        };
    }

    const changes = describeChanges(plan.sealedCopy?.copy ?? null, plan.files);
    const summary = {
        mode: plan.mode,
        failure: {
            code: plan.failure.code,
            reason: plan.failure.reason,
            ...(plan.failure.details ? { details: plan.failure.details } : {}),
        },
        changes,
        comparedWith: plan.sealedCopy ? `sealed copy ${plan.sealedCopy.seq}` : null,
        approverSource: plan.approver.source,
    };

    const refuse = (error: string, whatWouldBeRequired: string, extra: Record<string, unknown> = {}) => {
        ctx.ledger?.append(ctx.sessionId, "provenance.reseal.refused", { reason: error, failure: plan.failure.code, ...extra });
        return { ok: false, error, whatWouldBeRequired, ...summary, ...extra };
    };

    if (parsed.apply !== true) {
        ctx.ledger?.append(ctx.sessionId, "provenance.reseal.preview", {
            failure: plan.failure.code,
            mode: plan.mode,
            governanceHash: plan.governanceHash,
        });
        return {
            ok: true,
            preview: true,
            ...summary,
            confirm: { governanceHash: plan.governanceHash },
            whatWouldBeRequired:
                "Nothing was written. If every change above is intended, run provenanceReseal again with " +
                "{ apply: true, governanceHash: <confirm.governanceHash> } and typed APPLY, approved by the approver named in the seal" +
                (plan.approver.source ? ` (${plan.approver.source})` : "") +
                ". If not, put the files back exactly as sealed; Judgment clears on the next run.",
        };
    }

    const expected = String(parsed.governanceHash ?? "").trim();
    if (!expected) {
        return refuse(
            "CONFIRM_HASH_REQUIRED",
            "Preview first and send back its confirm.governanceHash, so the state you reviewed is the state that gets sealed"
        );
    }
    if (expected !== plan.governanceHash) {
        return refuse("PREVIEW_STALE", "The config changed after the preview. Preview again and review the new changes");
    }

    if (ctx.approval?.confirm !== "APPLY") {
        return refuse("HIL_REQUIRED", "Re-sealing needs typed APPLY (approval.confirm=APPLY)");
    }

    if (!plan.approver.identity) {
        if (plan.mode === "seal_damage") {
            return refuse(
                "NO_SEALED_COPY",
                "No sealed copy survived to name the approver, so this damage can't be approved from here. " +
                    "Put the original genesis.json (and any deleted seal records) back from a backup"
            );
        }
        return refuse(
            "SEALED_APPROVER_UNKNOWN",
            "This seal has no sealed copy naming its approver (it predates sealed copies, the copy is gone, or the sealed config named no approver). " +
                "Put config/auernyx.config.json and config/allowlist.json back exactly as sealed and run once with writes enabled: " +
                "the sealed copy is written then. Then make the change again and re-seal"
        );
    }

    const provided = approvalIdentity(ctx.approval);
    if (!provided || provided !== plan.approver.identity) {
        return refuse(
            "SEALED_APPROVER_MISMATCH",
            `The approval's identity must be the approver named in the seal (${plan.approver.source}), not the one in the edited config. ` +
                "A new approver takes over only after the current one approves the re-seal"
        );
    }

    const integrity = verifyLedgerIntegrity(ctx.repoRoot);
    if (!integrity.ok || integrity.truncated) {
        const reason = integrity.ok ? "AUDIT_LEDGER_UNVERIFIED_PREFIX" : "AUDIT_INVARIANT_VIOLATION";
        return refuse(
            reason,
            integrity.truncated
                ? "Ledger has grown beyond what can be fully verified from genesis in one check (see warnings): archive/rotate older ledger entries first"
                : "Ledger integrity must validate (hash chain)",
            { warnings: integrity.warnings }
        );
    }

    const checks = await runSelfTestChecks(ctx);
    if (!checks.ok) {
        return refuse(
            "PRECONDITIONS_NOT_MET",
            "Every self-test check must pass before a re-seal: fix what failed (see failedChecks and warnings), then retry",
            { failedChecks: checks.failedChecks, warnings: checks.warnings }
        );
    }

    const approvedAt = typeof ctx.approval?.at === "string" && ctx.approval.at.trim() ? ctx.approval.at : new Date().toISOString();
    // Same hash the receipt gives this approval (approvals.ndjson approvalHash).
    const approvalId = `sha256:${sha256Hex(stableStringify(ctx.approval))}`;
    const damage = plan.mode === "seal_damage";
    const changedFiles = changes.filter((c) => c.status !== "unchanged").map((c) => c.file);

    // The human decision is recorded first (same order as governanceUnlock):
    // if the seal write then fails, Judgment stays on.
    await recordFailure(ctx.repoRoot, {
        ...makeMfr({
            system: "provenance:obsidian",
            failure_type: "governance",
            trigger: `Obsidian's Judgment: ${plan.failure.code}`,
            inputs_snapshot: makeSnapshotHash({ failure: plan.failure.code, governanceHash: plan.governanceHash, changes }),
            pre_state: plan.sealedGovernanceHash ?? "unknown",
            post_state: plan.governanceHash,
            recovery_action: "override",
            authorized_by: provided,
            notes: damage
                ? "Human-approved re-seal after damage to the seal itself; verification restarts at this seal (anchor). Recorded so a seal change is never silent."
                : "Human-approved re-seal of a governance config change. Recorded so a seal change is never silent.",
        }),
        severity: damage ? "CRITICAL" : "HIGH",
        normalized_error_code: "PROVENANCE_RESEAL",
        signature: "governance::provenance:obsidian::reseal::PROVENANCE_RESEAL",
        approved_by: provided,
        approval_timestamp: approvedAt,
        risk_level: damage ? "CRITICAL" : "ELEVATED",
        blast_radius: ["provenance-seal", ...changedFiles],
    });

    const written = appendSealRecord(ctx.repoRoot, {
        failure: plan.failure,
        anchor: damage,
        expectedGovernanceHash: plan.governanceHash,
        approval: { approval_id: approvalId, actor_id: provided, approved_at: approvedAt, reason: String(ctx.approval?.reason ?? "") },
    });

    if (!written.ok) {
        // Keep the Kintsugi ledger honest: the approval above did not take.
        await recordFailure(ctx.repoRoot, {
            ...makeMfr({
                system: "provenance:obsidian",
                failure_type: "governance",
                trigger: `Re-seal not written: ${written.error}`,
                inputs_snapshot: makeSnapshotHash({ failure: plan.failure.code, governanceHash: plan.governanceHash, error: written.error }),
                pre_state: plan.sealedGovernanceHash ?? "unknown",
                post_state: plan.sealedGovernanceHash ?? "unknown",
                recovery_action: "none",
                authorized_by: provided,
                notes: written.detail ?? "",
            }),
            severity: "HIGH",
            normalized_error_code: "PROVENANCE_RESEAL_NOT_WRITTEN",
            signature: "governance::provenance:obsidian::reseal-not-written::PROVENANCE_RESEAL_NOT_WRITTEN",
        });
        return refuse(
            written.error,
            written.error === "PREVIEW_STALE"
                ? "The config changed while the re-seal checks ran. Preview again"
                : `The seal could not be written (${written.detail ?? written.error}); Judgment stays on`
        );
    }

    const after = verifyProvenance(ctx.repoRoot);
    if (after.ok) clearJudgment(ctx.repoRoot);
    ctx.ledger?.append(ctx.sessionId, "provenance.reseal", {
        seq: written.record.seq,
        anchor: damage,
        failure: plan.failure.code,
        governanceHash: written.record.governance_hash,
        approvedBy: provided,
    });

    return {
        ok: after.ok,
        resealed: {
            seq: written.record.seq,
            kind: damage ? "anchor" : "reseal",
            governance_hash: written.record.governance_hash,
            record_hash: written.record.record_hash,
        },
        judgmentCleared: after.ok,
        ...(after.ok ? {} : { provenance: after }),
        failure: summary.failure,
        changes,
    };
}
