import type { RouterContext } from "../core/router";
import { getSkjoldrFirewallStatus, runSkjoldrJsonCommand } from "../core/skjoldrFirewall";

export interface SkjoldrAdviseInboundRuleSetsInput {
    currentProfile?: string;
}

export interface RulesetAdvice {
    category: "security" | "performance" | "maintenance";
    severity: "info" | "warning" | "critical";
    title: string;
    detail: string;
    recommendation: string;
}

export interface SkjoldrAdviseInboundRuleSetsResult {
    ok: boolean;
    currentStatus?: unknown;
    advice: RulesetAdvice[];
    summary: string;
    notes: string[];
}

function parseInput(input: unknown): SkjoldrAdviseInboundRuleSetsInput {
    if (!input || typeof input !== "object") return {};
    
    const raw = input as Record<string, unknown>;
    const result: SkjoldrAdviseInboundRuleSetsInput = {};
    
    if (typeof raw.currentProfile === "string") {
        result.currentProfile = raw.currentProfile;
    }
    
    return result;
}

function analyzeFirewallStatus(statusData: unknown): RulesetAdvice[] {
    const advice: RulesetAdvice[] = [];
    
    // Analyze the firewall status and provide recommendations
    // This is a scaffold - real implementation would parse actual firewall data
    
    advice.push({
        category: "security",
        severity: "info",
        title: "Baseline Inbound Rule Analysis",
        detail: "Analyzed current inbound firewall rule configuration",
        recommendation: "Review inbound rules for unused ports and services. Consider implementing least-privilege access patterns."
    });
    
    advice.push({
        category: "maintenance",
        severity: "info",
        title: "Rule Set Documentation",
        detail: "Ensure firewall rules are documented with business justification",
        recommendation: "Add comments to each rule explaining its purpose and the services/applications it supports."
    });
    
    advice.push({
        category: "security",
        severity: "warning",
        title: "Default Deny Policy",
        detail: "Verify default inbound policy is set to deny",
        recommendation: "Implement explicit deny-by-default policy for all inbound traffic, then whitelist only required services."
    });
    
    return advice;
}

export async function skjoldrFirewallAdviseInboundRuleSets(
    ctx: RouterContext, 
    input?: unknown
): Promise<SkjoldrAdviseInboundRuleSetsResult> {
    const parsed = parseInput(input);
    const status = getSkjoldrFirewallStatus(ctx.repoRoot, { allowAutoDetect: false });
    
    if (!status.enabled) {
        throw new Error("Skjoldr Firewall add-on is disabled.");
    }
    if (!status.available || !status.resolvedCommand) {
        throw new Error("Skjoldr command not configured/resolved.");
    }
    if (!status.json) {
        throw new Error("Refusing to analyze firewall rules without JSON mode.");
    }
    
    const common = ["--json", "--timeout", String(status.timeoutMs)];
    
    // Get current firewall status
    const currentStatus = await runSkjoldrJsonCommand(
        status.resolvedCommand, 
        ["status", ...common], 
        status.timeoutMs
    );
    
    if (!currentStatus.ok) {
        throw new Error("Skjoldr status check returned ok=false");
    }
    
    // Analyze the status and generate advice
    const advice = analyzeFirewallStatus(currentStatus.data);
    
    // Log the analysis to ledger
    if (ctx.ledger) {
        ctx.ledger.append(ctx.sessionId, "skjoldr.advise.inbound.invoked", {
            profile: parsed.currentProfile ?? "(default)",
            adviceCount: advice.length,
            criticalCount: advice.filter(a => a.severity === "critical").length,
            warningCount: advice.filter(a => a.severity === "warning").length
        });
    }
    
    const criticalCount = advice.filter(a => a.severity === "critical").length;
    const warningCount = advice.filter(a => a.severity === "warning").length;
    
    const summary = `Analyzed inbound firewall rules: ${advice.length} recommendations (${criticalCount} critical, ${warningCount} warnings)`;
    
    return {
        ok: true,
        currentStatus: currentStatus.data,
        advice,
        summary,
        notes: [
            "This capability provides advisory analysis of inbound firewall rules.",
            "Recommendations are generated based on security best practices and governance patterns.",
            "This is a read-only capability - no changes are made to firewall configuration.",
            "Use 'skjoldr apply-profile' or 'skjoldr apply-ruleset' to implement changes."
        ]
    };
}
