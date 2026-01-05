import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import type { Plan } from "./planner";
import type { CapabilityName } from "./policy";

export type VsCodePolicy = {
    version: string;
    mode: "governance-first" | string;
    write_gate: {
        required: boolean;
        cli_flag: string;
        env_var: string;
        env_required_value: string;
    };
    two_step_flow: {
        default_action: "preview" | "apply" | string;
        require_preview_before_apply: boolean;
    };
    protected_paths: string[];
    canon_paths: string[];
    canon_rules: {
        must_be_gitignored: boolean;
        never_commit_canon: boolean;
    };
    git_rules: {
        require_repo_root_detection: boolean;
        capture_status_porcelain_pre: boolean;
        capture_status_porcelain_post: boolean;
        deny_history_rewrites: boolean;
    };
    refusal_conditions: string[];
    receipt: {
        emit_on_refusal: boolean;
        fields: string[];
    };
    closeout_reminder: {
        enabled: boolean;
        message: string;
    };
};

export const DEFAULT_VSCODE_POLICY: VsCodePolicy = {
    version: "auernyx-vscode-policy@1",
    mode: "governance-first",
    write_gate: {
        required: true,
        cli_flag: "--apply",
        env_var: "AUERNYX_WRITE_ENABLED",
        env_required_value: "1"
    },
    two_step_flow: {
        default_action: "preview",
        require_preview_before_apply: true
    },
    protected_paths: [".git/**", "**/node_modules/**", "**/.venv/**", "**/dist/**"],
    canon_paths: [".canon/**", "var/canon/**"],
    canon_rules: { must_be_gitignored: true, never_commit_canon: true },
    git_rules: {
        require_repo_root_detection: true,
        capture_status_porcelain_pre: true,
        capture_status_porcelain_post: true,
        deny_history_rewrites: true
    },
    refusal_conditions: [
        "missing_write_gate",
        "attempt_write_protected_path",
        "canon_not_gitignored",
        "request_disables_audit_or_receipts",
        "request_introduces_silent_bypass",
        "ambiguous_side_effect_request"
    ],
    receipt: {
        emit_on_refusal: true,
        fields: [
            "timestamp_local",
            "timestamp_utc",
            "repo_root",
            "invocation",
            "write_gate_state",
            "git_porcelain_pre",
            "git_porcelain_post",
            "proposed_files",
            "changed_files",
            "plan_hash_sha256",
            "diff_hash_sha256",
            "receipt_hash_sha256",
            "decision",
            "reason_code"
        ]
    },
    closeout_reminder: {
        enabled: true,
        message: "Run baseline pre-check at start, baseline post-check at end of workday; SHA-256 hash + verify + push to git before closing."
    }
};

export function loadVsCodePolicy(repoRoot: string): VsCodePolicy {
    try {
        const fp = path.join(repoRoot, "config", "vscode-policy.json");
        if (!fs.existsSync(fp)) return DEFAULT_VSCODE_POLICY;
        const raw = fs.readFileSync(fp, "utf8");
        const parsed = JSON.parse(raw) as Partial<VsCodePolicy>;
        return {
            ...DEFAULT_VSCODE_POLICY,
            ...parsed,
            write_gate: { ...DEFAULT_VSCODE_POLICY.write_gate, ...(parsed as any).write_gate },
            two_step_flow: { ...DEFAULT_VSCODE_POLICY.two_step_flow, ...(parsed as any).two_step_flow },
            canon_rules: { ...DEFAULT_VSCODE_POLICY.canon_rules, ...(parsed as any).canon_rules },
            git_rules: { ...DEFAULT_VSCODE_POLICY.git_rules, ...(parsed as any).git_rules },
            receipt: { ...DEFAULT_VSCODE_POLICY.receipt, ...(parsed as any).receipt },
            closeout_reminder: { ...DEFAULT_VSCODE_POLICY.closeout_reminder, ...(parsed as any).closeout_reminder },
            protected_paths: Array.isArray((parsed as any).protected_paths) ? (parsed as any).protected_paths : DEFAULT_VSCODE_POLICY.protected_paths,
            canon_paths: Array.isArray((parsed as any).canon_paths) ? (parsed as any).canon_paths : DEFAULT_VSCODE_POLICY.canon_paths,
            refusal_conditions: Array.isArray((parsed as any).refusal_conditions) ? (parsed as any).refusal_conditions : DEFAULT_VSCODE_POLICY.refusal_conditions
        };
    } catch {
        return DEFAULT_VSCODE_POLICY;
    }
}

export type PreviewBundle = {
    capability?: CapabilityName;
    decision: "OK_PREVIEW_ONLY" | "OK_APPLIED" | "REFUSED";
    diffPreviewText: string;
    diffHashSha256: string;
    planHashSha256: string;
};

function sha256Hex(buf: Buffer | string): string {
    return crypto.createHash("sha256").update(buf).digest("hex");
}

export function computePlanHash(plan: Plan | undefined): string {
    try {
        return sha256Hex(JSON.stringify(plan ?? null));
    } catch {
        return sha256Hex("[unhashable]");
    }
}

export function computePseudoDiff(args: { capability?: CapabilityName; proposedFiles: string[] }): { text: string; sha256: string } {
    const cap = args.capability ?? "(unknown)";
    const lines: string[] = [];
    lines.push(`# Diff Preview (pseudo) — ${cap}`);
    if (!args.proposedFiles.length) {
        lines.push("(No file write targets declared for this capability.)");
    } else {
        lines.push("Proposed write targets:");
        for (const f of args.proposedFiles) lines.push(`- ${f}`);
    }
    lines.push("");
    lines.push("NOTE: Exact line diffs are capability-dependent and may require a dedicated preview step.");
    const text = lines.join("\n") + "\n";
    return { text, sha256: sha256Hex(text) };
}

export function canonGitignoreStatus(repoRoot: string): { ok: boolean; missing: string[] } {
    try {
        const fp = path.join(repoRoot, ".gitignore");
        if (!fs.existsSync(fp)) return { ok: false, missing: [".gitignore_missing"] };
        const raw = fs.readFileSync(fp, "utf8").replace(/\r\n/g, "\n");
        const required = [".canon/", "var/canon/"];
        const missing = required.filter((r) => !raw.split("\n").some((l) => l.trim() === r));
        return { ok: missing.length === 0, missing };
    } catch {
        return { ok: false, missing: [".gitignore_unreadable"] };
    }
}
