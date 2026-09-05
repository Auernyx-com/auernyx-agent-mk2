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
    // Same landmine pattern found and fixed in governanceRefusal.ts's
    // isPathProtected: this used to return undefined (-> not protected) for
    // a path outside the workspace, the same "escape = exempt" inversion.
    // Currently unreachable via this function's one real caller (that outer
    // function already catches the escape case first), but fixed here too
    // for consistency and so it can't resurface if this is ever called
    // directly from a new site.
    let rel: string;
    try {
        rel = path.relative(workspaceRoot, targetPath).replace(/\\/g, "/");
    } catch {
        // Couldn't even establish a relative path — ambiguous, fail closed.
        return true;
    }

    if (rel.startsWith("..")) return true; // escapes the workspace: protected, not exempt.
    if (!rel) return false; // rel === "" means targetPath IS workspaceRoot itself.

    for (const p of PROTECTED_PREFIXES) {
        if (rel === p || rel.startsWith(p + "/")) return true;
    }

    for (const frag of PROTECTED_CONTAINS) {
        if (rel.includes(frag)) return true;
    }

    return false;
}
