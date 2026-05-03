import type { RouterContext } from "../core/router";
import { sha256Hex, stableStringify } from "../core/crypto";

export type DependencyEcosystem = "npm" | "pypi" | "maven";

export interface AnalyzeDependencyInput {
    packageName: string;
    oldVersion: string;
    newVersion: string;
    ecosystem: DependencyEcosystem;
}

export interface SecurityAdvisory {
    id: string;
    severity: "low" | "moderate" | "high" | "critical" | "unknown";
    title: string;
    url: string;
}

export interface AnalyzeDependencyOutput {
    ok: boolean;
    packageName: string;
    oldVersion: string;
    newVersion: string;
    ecosystem: DependencyEcosystem;
    versionJump: "patch" | "minor" | "major" | "unknown";
    riskLevel: "low" | "medium" | "high" | "critical";
    recommendation: "approve" | "review" | "reject";
    breakingChanges: boolean;
    securityImpact: "none" | "fixes" | "introduces" | "unknown";
    securityAdvisories: SecurityAdvisory[];
    advisories: SecurityAdvisory[];
    publishDate?: string;
    changelogUrl?: string;
    changelogSnippet?: string;
    npmUrl: string;
    evidence: string[];
    analysisHash: string;
    timestamp: string;
}

type VersionMeta = { description?: string; readme?: string };

type NpmPackument = {
    name?: string;
    versions?: Record<string, VersionMeta | unknown>;
    time?: Record<string, string>;
    repository?: { url?: string } | string;
    readme?: string;
    description?: string;
};

type NpmBulkAdvisory = {
    id?: string | number;
    ghsa_id?: string;
    severity?: string;
    title?: string;
    url?: string;
};

const CACHE_LIMIT = 200;
const PACKAGE_CACHE = new Map<string, NpmPackument | null>();
const ADVISORY_CACHE = new Map<string, SecurityAdvisory[]>();

function setBoundedCache<T>(cache: Map<string, T>, key: string, value: T): void {
    if (!cache.has(key) && cache.size >= CACHE_LIMIT) {
        const first = cache.keys().next().value;
        if (typeof first === "string") cache.delete(first);
    }
    cache.set(key, value);
}

function semverParts(v: string): [number, number, number] | null {
    const m = v.trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/i);
    if (!m) return null;
    return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function classifyJump(oldVersion: string, newVersion: string): "patch" | "minor" | "major" | "unknown" {
    const oldP = semverParts(oldVersion);
    const newP = semverParts(newVersion);
    if (!oldP || !newP) return "unknown";

    if (newP[0] !== oldP[0]) return "major";
    if (newP[1] < oldP[1]) return "unknown"; // downgrade
    if (newP[1] > oldP[1]) return "minor";
    if (newP[2] < oldP[2]) return "unknown"; // downgrade
    if (newP[2] > oldP[2]) return "patch";
    return "patch"; // same version
}

function parseInput(input?: unknown): AnalyzeDependencyInput {
    if (!input || typeof input !== "object") throw new Error("input must be an object");

    const raw = input as Record<string, unknown>;
    const packageName = String(raw.packageName ?? "").trim();
    const oldVersion = String(raw.oldVersion ?? "").trim();
    const newVersion = String(raw.newVersion ?? "").trim();
    const ecosystemRaw = String(raw.ecosystem ?? "npm").trim().toLowerCase();

    if (!packageName) throw new Error("packageName is required");
    if (!semverParts(oldVersion)) throw new Error(`oldVersion "${oldVersion}" must be semver-like`);
    if (!semverParts(newVersion)) throw new Error(`newVersion "${newVersion}" must be semver-like`);
    if (ecosystemRaw !== "npm" && ecosystemRaw !== "pypi" && ecosystemRaw !== "maven") {
        throw new Error(`ecosystem "${ecosystemRaw}" must be one of: npm, pypi, maven`);
    }

    return {
        packageName,
        oldVersion,
        newVersion,
        ecosystem: ecosystemRaw as DependencyEcosystem
    };
}

function safeParseForFailure(input?: unknown): AnalyzeDependencyInput {
    if (input && typeof input === "object") {
        const raw = input as Record<string, unknown>;
        const ecoRaw = String(raw.ecosystem ?? "npm").trim().toLowerCase();
        const ecosystem: DependencyEcosystem = ecoRaw === "npm" || ecoRaw === "pypi" || ecoRaw === "maven" ? ecoRaw : "npm";
        return {
            packageName: String(raw.packageName ?? "unknown").trim() || "unknown",
            oldVersion: String(raw.oldVersion ?? "0.0.0").trim() || "0.0.0",
            newVersion: String(raw.newVersion ?? "0.0.0").trim() || "0.0.0",
            ecosystem
        };
    }
    return { packageName: "unknown", oldVersion: "0.0.0", newVersion: "0.0.0", ecosystem: "npm" };
}

async function fetchJson<T>(url: string, options?: { method?: string; body?: string; timeoutMs?: number }): Promise<T> {
    const timeoutMs = options?.timeoutMs ?? 7000;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const fetchOptions: RequestInit = {
            method: options?.method ?? "GET",
            signal: controller.signal
        };

        if (options?.body) {
            fetchOptions.body = options.body;
            fetchOptions.headers = {
                "content-type": "application/json",
                "content-length": String(Buffer.byteLength(options.body))
            };
        }

        const response = await fetch(url, fetchOptions);
        clearTimeout(timeout);

        if (!response.ok) {
            throw new Error(`http_${response.status}`);
        }

        return (await response.json()) as T;
    } catch (err) {
        clearTimeout(timeout);
        if (err instanceof Error && err.name === "AbortError") {
            throw new Error("timeout");
        }
        throw err;
    }
}

async function fetchNpmPackument(packageName: string, targetVersion: string): Promise<NpmPackument | null> {
    const cacheKey = `${packageName}@${targetVersion}`;
    if (PACKAGE_CACHE.has(cacheKey)) return PACKAGE_CACHE.get(cacheKey) ?? null;

    const safe = encodeURIComponent(packageName);
    try {
        const data = await fetchJson<NpmPackument>(`https://registry.npmjs.org/${safe}`);

        // prune aggressively to avoid retaining giant historical packuments
        if (data.versions) {
            const only = data.versions[targetVersion];
            data.versions = only ? { [targetVersion]: only } : {};
        }

        setBoundedCache(PACKAGE_CACHE, cacheKey, data);
        return data;
    } catch (err) {
        const msg = err instanceof Error ? err.message : "error";
        if (msg === "http_404") {
            setBoundedCache(PACKAGE_CACHE, cacheKey, null);
            return null;
        }
        throw err;
    }
}

async function fetchAdvisoriesFor(packageName: string, version: string): Promise<SecurityAdvisory[]> {
    const cacheKey = `${packageName}@${version}`;
    if (ADVISORY_CACHE.has(cacheKey)) return ADVISORY_CACHE.get(cacheKey) ?? [];

    const payload = JSON.stringify({ [packageName]: [version] });

    try {
        const result = await fetchJson<Record<string, NpmBulkAdvisory[]>>(
            "https://registry.npmjs.org/-/npm/v1/security/advisories/bulk",
            { method: "POST", body: payload, timeoutMs: 6000 }
        );

        const advisories = (Array.isArray(result[packageName]) ? result[packageName] : []).map((a) => {
            const id = String(a.ghsa_id ?? a.id ?? "unknown");
            const sevRaw = String(a.severity ?? "unknown").toLowerCase();
            const severity: SecurityAdvisory["severity"] =
                sevRaw === "low" || sevRaw === "moderate" || sevRaw === "high" || sevRaw === "critical"
                    ? sevRaw
                    : "unknown";

            return {
                id,
                severity,
                title: String(a.title ?? "(untitled advisory)"),
                url: String(a.url ?? `https://github.com/advisories/${id}`)
            };
        }).sort((a, b) => a.id.localeCompare(b.id));

        setBoundedCache(ADVISORY_CACHE, cacheKey, advisories);
        return advisories;
    } catch {
        return [];
    }
}

const BREAKING_RE = [
    { re: /BREAKING[\s_-]?CHANGE/i, reason: "Contains 'breaking change' marker" },
    { re: /dropped\s+support\s+for/i, reason: "Mentions dropped support" },
    { re: /removed\s+(?:the\s+)?(?:\w+\s+)?api/i, reason: "Mentions removed API" },
    { re: /incompatible\s+(change|api|break)/i, reason: "Mentions incompatible changes" }
];

function detectBreakingSignals(data: NpmPackument, newVersion: string): { signals: string[]; snippet?: string } {
    const versionMeta = (data.versions?.[newVersion] ?? {}) as VersionMeta;
    const text = `${versionMeta.description ?? ""}\n${versionMeta.readme ?? ""}\n${data.description ?? ""}\n${data.readme ?? ""}`.slice(0, 12000);
    const lines = text.split("\n").map((x) => x.trim()).filter(Boolean);

    const signals = BREAKING_RE.filter((r) => r.re.test(text)).map((r) => r.reason);
    const snippet = lines.find((line) => BREAKING_RE.some((r) => r.re.test(line)));
    return { signals, snippet };
}

function inferChangelogUrl(data: NpmPackument, packageName: string): string {
    const repo = typeof data.repository === "string" ? data.repository : data.repository?.url ?? "";
    const gh = repo.match(/github\.com[/:]([^/]+\/[^/.]+?)(?:\.git)?$/i);
    if (gh) return `https://github.com/${gh[1]}/blob/HEAD/CHANGELOG.md`;
    return `https://www.npmjs.com/package/${encodeURIComponent(packageName)}?activeTab=versions`;
}

function classifySecurityImpact(oldAdvisories: SecurityAdvisory[], newAdvisories: SecurityAdvisory[]): "none" | "fixes" | "introduces" {
    const oldIds = new Set(oldAdvisories.map((x) => x.id));
    const newIds = new Set(newAdvisories.map((x) => x.id));
    if ([...newIds].some((id) => !oldIds.has(id))) return "introduces";
    if ([...oldIds].some((id) => !newIds.has(id))) return "fixes";
    return "none";
}

function scoreRisk(params: {
    jump: "patch" | "minor" | "major" | "unknown";
    ecosystem: DependencyEcosystem;
    oldAdvisories: SecurityAdvisory[];
    newAdvisories: SecurityAdvisory[];
    breakingSignals: string[];
    isYoung: boolean;
}): { riskLevel: AnalyzeDependencyOutput["riskLevel"]; recommendation: AnalyzeDependencyOutput["recommendation"]; evidence: string[] } {
    const evidence: string[] = [];

    if (params.ecosystem !== "npm") {
        evidence.push(`Ecosystem '${params.ecosystem}' not yet implemented — fail-closed to manual review.`);
        return { riskLevel: "high", recommendation: "review", evidence };
    }

    const oldIds = new Set(params.oldAdvisories.map((x) => x.id));
    const introducesVuln = params.newAdvisories.some((x) => !oldIds.has(x.id));
    const fixesVuln = params.oldAdvisories.some((x) => !new Set(params.newAdvisories.map((n) => n.id)).has(x.id));

    if (introducesVuln && params.newAdvisories.length > 0) {
        evidence.push(`CRITICAL: New version introduces ${params.newAdvisories.length} vulnerabilities.`);
        for (const adv of params.newAdvisories) {
            evidence.push(`  [${adv.severity.toUpperCase()}] ${adv.id}: ${adv.title} — ${adv.url}`);
        }
        return { riskLevel: "critical", recommendation: "reject", evidence };
    }

    if (params.breakingSignals.length > 0) {
        evidence.push(...params.breakingSignals.map((s) => `HIGH: Breaking-signal: ${s}`));
        return { riskLevel: "high", recommendation: "review", evidence };
    }

    if (params.jump === "major" || params.jump === "unknown") {
        evidence.push(`HIGH: ${params.jump.toUpperCase()} version jump detected.`);
        return { riskLevel: "high", recommendation: "review", evidence };
    }

    if (params.jump === "minor") {
        evidence.push("MEDIUM: Minor version jump detected. Requires review.");
        return { riskLevel: "medium", recommendation: "review", evidence };
    }

    if (params.isYoung) {
        evidence.push("MEDIUM: Version is highly recent (< 48 hours) or missing publish metadata.");
        return { riskLevel: "medium", recommendation: "review", evidence };
    }

    if (fixesVuln) {
        evidence.push("LOW: Patch update resolves existing advisories with no new vulnerabilities.");
        return { riskLevel: "low", recommendation: "approve", evidence };
    }

    if (params.jump === "patch") {
        evidence.push("LOW: Patch version jump with no high-risk signals.");
        return { riskLevel: "low", recommendation: "approve", evidence };
    }

    evidence.push("HIGH: Unclassified risk state — fail-closed to review.");
    return { riskLevel: "high", recommendation: "review", evidence };
}

function successOutput(
    parsed: AnalyzeDependencyInput,
    scored: { riskLevel: AnalyzeDependencyOutput["riskLevel"]; recommendation: AnalyzeDependencyOutput["recommendation"]; evidence: string[] },
    advisories: SecurityAdvisory[],
    securityImpact: AnalyzeDependencyOutput["securityImpact"],
    breakingSignals: string[],
    timestamp: string,
    packument?: NpmPackument,
    publishDate?: string,
    changelogSnippet?: string
): AnalyzeDependencyOutput {
    const changelogUrl = packument ? inferChangelogUrl(packument, parsed.packageName) : undefined;
    const jump = classifyJump(parsed.oldVersion, parsed.newVersion);
    const analysisSeed = {
        packageName: parsed.packageName,
        oldVersion: parsed.oldVersion,
        newVersion: parsed.newVersion,
        ecosystem: parsed.ecosystem,
        jump,
        riskLevel: scored.riskLevel,
        recommendation: scored.recommendation,
        securityImpact,
        breakingSignalIds: breakingSignals.slice().sort(),
        advisoryIds: advisories.map((a) => a.id).sort()
    };

    return {
        ok: true,
        packageName: parsed.packageName,
        oldVersion: parsed.oldVersion,
        newVersion: parsed.newVersion,
        ecosystem: parsed.ecosystem,
        versionJump: jump,
        riskLevel: scored.riskLevel,
        recommendation: scored.recommendation,
        breakingChanges: breakingSignals.length > 0,
        securityImpact,
        securityAdvisories: advisories,
        advisories,
        publishDate,
        changelogUrl,
        changelogSnippet,
        npmUrl: `https://www.npmjs.com/package/${encodeURIComponent(parsed.packageName)}/v/${parsed.newVersion}`,
        evidence: scored.evidence,
        analysisHash: sha256Hex(stableStringify(analysisSeed)),
        timestamp
    };
}

function failClosedOutput(input: AnalyzeDependencyInput, reason: string, timestamp: string): AnalyzeDependencyOutput {
    const analysisSeed = {
        packageName: input.packageName,
        oldVersion: input.oldVersion,
        newVersion: input.newVersion,
        ecosystem: input.ecosystem,
        status: "fail_closed"
    };
    const advisories: SecurityAdvisory[] = [];

    return {
        ok: false,
        packageName: input.packageName,
        oldVersion: input.oldVersion,
        newVersion: input.newVersion,
        ecosystem: input.ecosystem,
        versionJump: "unknown",
        riskLevel: "critical",
        recommendation: "reject",
        breakingChanges: false,
        securityImpact: "unknown",
        securityAdvisories: advisories,
        advisories,
        changelogUrl: `https://www.npmjs.com/package/${encodeURIComponent(input.packageName)}`,
        npmUrl: `https://www.npmjs.com/package/${encodeURIComponent(input.packageName)}`,
        evidence: [`Fail-closed: ${reason}`],
        analysisHash: sha256Hex(stableStringify(analysisSeed)),
        timestamp
    };
}

export async function analyzeDependency(_ctx: RouterContext, input?: unknown): Promise<AnalyzeDependencyOutput> {
    const timestamp = new Date().toISOString();

    let parsed: AnalyzeDependencyInput;
    try {
        parsed = parseInput(input);
    } catch (err) {
        const reason = err instanceof Error ? err.message : "invalid_input";
        return failClosedOutput(safeParseForFailure(input), `Invalid input: ${reason}`, timestamp);
    }

    if (parsed.ecosystem !== "npm") {
        const scored = scoreRisk({
            jump: classifyJump(parsed.oldVersion, parsed.newVersion),
            ecosystem: parsed.ecosystem,
            oldAdvisories: [],
            newAdvisories: [],
            breakingSignals: [],
            isYoung: false
        });
        return successOutput(parsed, scored, [], "unknown", [], timestamp);
    }

    try {
        const packument = await fetchNpmPackument(parsed.packageName, parsed.newVersion);
        if (!packument) return failClosedOutput(parsed, "package not found in npm registry", timestamp);
        if (!Object.prototype.hasOwnProperty.call(packument.versions ?? {}, parsed.newVersion)) {
            return failClosedOutput(parsed, `newVersion '${parsed.newVersion}' is not published`, timestamp);
        }

        const breaking = detectBreakingSignals(packument, parsed.newVersion);
        const [oldAdvisories, newAdvisories] = await Promise.all([
            fetchAdvisoriesFor(parsed.packageName, parsed.oldVersion),
            fetchAdvisoriesFor(parsed.packageName, parsed.newVersion)
        ]);

        const rawDate = packument.time?.[parsed.newVersion];
        const parsedDate = rawDate ? Date.parse(rawDate) : Number.NaN;
        const isYoung = Number.isNaN(parsedDate) || (Date.now() - parsedDate < 172_800_000);

        const scored = scoreRisk({
            jump: classifyJump(parsed.oldVersion, parsed.newVersion),
            ecosystem: "npm",
            oldAdvisories,
            newAdvisories,
            breakingSignals: breaking.signals,
            isYoung
        });

        if (rawDate) scored.evidence.push(`Published at: ${rawDate}`);
        scored.evidence.push(`Registry package: ${packument.name ?? parsed.packageName}`);

        const securityImpact = classifySecurityImpact(oldAdvisories, newAdvisories);
        return successOutput(
            parsed,
            scored,
            newAdvisories,
            securityImpact,
            breaking.signals,
            timestamp,
            packument,
            rawDate,
            breaking.snippet
        );
    } catch (err) {
        const msg = err instanceof Error ? err.message : "network failure";
        return failClosedOutput(parsed, `Registry unavailable: ${msg}`, timestamp);
    }
}
