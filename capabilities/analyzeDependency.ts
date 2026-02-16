import type { RouterContext } from "../core/router";

export interface AnalyzeDependencyInput {
    packageManager?: "npm" | "pnpm" | "yarn";
    packageName?: string;
    fromVersion?: string;
    toVersion?: string;
    pullRequest?: {
        number?: number;
        title?: string;
        body?: string;
        files?: string[];
    };
}

export interface AnalyzeDependencyResult {
    summary: string;
    riskLevel: "low" | "medium" | "high" | "unknown";
    autoApproveEligible: boolean;
    evidence: string[];
    checks: {
        sourceMetadata: "todo" | "pass" | "fail";
        securityAdvisories: "todo" | "pass" | "fail";
        breakingChanges: "todo" | "pass" | "fail";
        trustScore: "todo" | "pass" | "fail";
    };
    integrationPoints: {
        npmApi: string;
        securityFeed: string;
        changelogParsing: string;
        ledgerReceipts: string;
        policyGate: string;
    };
    notes: string[];
}

function parseInput(input: unknown): AnalyzeDependencyInput {
    if (!input || typeof input !== "object") return {};

    const raw = input as Record<string, unknown>;
    const result: AnalyzeDependencyInput = {};

    // packageManager: "npm" | "pnpm" | "yarn"
    if (typeof raw.packageManager === "string") {
        if (raw.packageManager === "npm" || raw.packageManager === "pnpm" || raw.packageManager === "yarn") {
            result.packageManager = raw.packageManager;
        }
    }

    // packageName, fromVersion, toVersion: string
    if (typeof raw.packageName === "string") {
        result.packageName = raw.packageName;
    }
    if (typeof raw.fromVersion === "string") {
        result.fromVersion = raw.fromVersion;
    }
    if (typeof raw.toVersion === "string") {
        result.toVersion = raw.toVersion;
    }

    // pullRequest: nested object with optional fields
    const pr = raw.pullRequest;
    if (pr && typeof pr === "object") {
        const prRaw = pr as Record<string, unknown>;
        const pullRequest: NonNullable<AnalyzeDependencyInput["pullRequest"]> = {};

        if (typeof prRaw.number === "number") {
            pullRequest.number = prRaw.number;
        }
        if (typeof prRaw.title === "string") {
            pullRequest.title = prRaw.title;
        }
        if (typeof prRaw.body === "string") {
            pullRequest.body = prRaw.body;
        }
        if (Array.isArray(prRaw.files)) {
            const files: string[] = [];
            for (const f of prRaw.files) {
                if (typeof f === "string") {
                    files.push(f);
                }
            }
            if (files.length > 0) {
                pullRequest.files = files;
            }
        }

        if (
            pullRequest.number !== undefined ||
            pullRequest.title !== undefined ||
            pullRequest.body !== undefined ||
            pullRequest.files !== undefined
        ) {
            result.pullRequest = pullRequest;
        }
    }

    return result;
}

// Auernyx Mk2 - Dependency Analysis Capability scaffold
// Governed, receipt-backed, policy-enforced dependency review.
export async function analyzeDependency(ctx: RouterContext, input?: unknown): Promise<AnalyzeDependencyResult> {
    const parsed = parseInput(input);

    const pkg = parsed.packageName ?? "(unresolved)";
    const from = parsed.fromVersion ?? "(unknown)";
    const to = parsed.toVersion ?? "(unknown)";

    if (ctx.ledger) {
        ctx.ledger.append(ctx.sessionId, "dependency.analysis.scaffold.invoked", {
            packageName: pkg,
            fromVersion: from,
            toVersion: to,
            packageManager: parsed.packageManager ?? "npm"
        });
    }

    return {
        summary: `Scaffold analysis for ${pkg} ${from} -> ${to}.`,
        riskLevel: "unknown",
        autoApproveEligible: false,
        evidence: [
            "TODO: Pull package metadata (npm registry API)",
            "TODO: Pull advisories (GitHub Advisory DB / OSV / npm audit)",
            "TODO: Parse release notes/changelog and identify breaking signals",
            "TODO: Compute governed risk score + trust score"
        ],
        checks: {
            sourceMetadata: "todo",
            securityAdvisories: "todo",
            breakingChanges: "todo",
            trustScore: "todo"
        },
        integrationPoints: {
            npmApi: "Insert package metadata + dist-tag lookup in capabilities/analyzeDependency.ts",
            securityFeed: "Insert advisory enrichment in capabilities/analyzeDependency.ts",
            changelogParsing: "Insert release note parsing and semver diffing in capabilities/analyzeDependency.ts",
            ledgerReceipts: "Emit additional ledger.append() evidence events per check",
            policyGate: "Keep capability read-only; policy can gate auto-approval in workflow"
        },
        notes: [
            "Designed for 3-worker implementation: metadata, security, compatibility.",
            "Read-only by default; intended for Dependabot PR analysis.",
            "Workflow integration file: .github/workflows/auernyx-dependency-review.yml"
        ]
    };
}
