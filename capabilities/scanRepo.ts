import * as fs from "fs";
import * as path from "path";
import type { RouterContext } from "../core/router";
import { loadConfig } from "../core/config";

export interface ScanRepoInput {
    targetDir?: string;
}

function parseScanRepoInput(input: unknown): ScanRepoInput {
    if (!input || typeof input !== "object") return {};
    const maybe = input as Record<string, unknown>;
    return {
        targetDir: typeof maybe.targetDir === "string" ? maybe.targetDir : undefined
    };
}

export async function scanRepo(ctx: RouterContext, input?: unknown): Promise<{ root: string; fileCount: number }> {
    let fileCount = 0;
    const parsed = parseScanRepoInput(input);
    const root = parsed.targetDir ? path.resolve(parsed.targetDir) : ctx.repoRoot;

    // Path enforcement: by default only allow scanning within repoRoot.
    // Additional allowed roots can be configured under config.auernyx.config.json -> paths.scanAllowedRoots.
    const cfg = loadConfig(ctx.repoRoot);
    const allowedRoots = (cfg.paths.scanAllowedRoots.length > 0 ? cfg.paths.scanAllowedRoots : [ctx.repoRoot]).map((p) => path.resolve(p));

    const isWithin = (candidate: string, base: string) => {
        const rel = path.relative(base, candidate);
        return !!rel && !rel.startsWith("..") && !path.isAbsolute(rel);
    };

    const allowed = allowedRoots.some((base) => candidateEqualsOrWithin(root, base));

    function candidateEqualsOrWithin(candidate: string, base: string): boolean {
        const c = path.resolve(candidate);
        const b = path.resolve(base);
        if (c.toLowerCase() === b.toLowerCase()) return true;
        return isWithin(c, b);
    }

    if (!allowed) {
        throw new Error("scan_root_not_allowed");
    }

    function walk(dir: string) {
        for (const entry of fs.readdirSync(dir)) {
            const res = path.resolve(dir, entry);
            const stat = fs.statSync(res);
            if (stat.isDirectory()) {
                if (entry === "node_modules" || entry === "dist" || entry === "logs" || entry === "artifacts") continue;
                walk(res);
            } else {
                fileCount++;
            }
        }
    }

    walk(root);
    return { root, fileCount };
}
