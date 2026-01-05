import { execFileSync } from "child_process";

export type GitStatus = {
    ok: boolean;
    repoRoot?: string;
    porcelain?: string;
    error?: string;
};

function runGit(cwd: string, args: string[]): string {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

export function detectGitRepoRoot(cwd: string): GitStatus {
    try {
        const out = runGit(cwd, ["rev-parse", "--show-toplevel"]).trim();
        if (!out) return { ok: false, error: "git_no_repo_root" };
        return { ok: true, repoRoot: out };
    } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
}

export function gitStatusPorcelain(cwd: string): GitStatus {
    try {
        const root = detectGitRepoRoot(cwd);
        if (!root.ok || !root.repoRoot) return root;
        const porcelain = runGit(root.repoRoot, ["status", "--porcelain"]).replace(/\r\n/g, "\n");
        return { ok: true, repoRoot: root.repoRoot, porcelain };
    } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
}

export function isDirtyPorcelain(porcelain: string | undefined): boolean {
    return typeof porcelain === "string" && porcelain.trim().length > 0;
}
