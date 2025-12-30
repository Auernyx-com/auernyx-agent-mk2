import * as path from "path";

const PROTECTED_PREFIXES = [
    "kintsugi",
    ".kintsugi",
    ".auernyx",
    ".auernyx/kintsugi",
    ".vscode/auernyx",
    ".vscode/auernyx/kintsugi",
];

const PROTECTED_CONTAINS = [
    "ledger/records",
    "policy/history",
    "active.policy.json",
    ".policy.json",
];

export function isProtectedWorkspacePath(workspaceRoot: string, targetPath: string): boolean {
    const rel = normalizeRel(workspaceRoot, targetPath);
    if (!rel) return false;

    for (const p of PROTECTED_PREFIXES) {
        if (rel === p || rel.startsWith(p + "/")) return true;
    }

    for (const frag of PROTECTED_CONTAINS) {
        if (rel.includes(frag)) return true;
    }

    return false;
}

function normalizeRel(workspaceRoot: string, targetPath: string): string | undefined {
    try {
        const rel = path.relative(workspaceRoot, targetPath);
        if (!rel || rel.startsWith("..")) return undefined;
        return rel.replace(/\\/g, "/");
    } catch {
        return undefined;
    }
}
