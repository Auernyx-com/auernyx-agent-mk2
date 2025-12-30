import * as fs from "fs";
import * as path from "path";
import { GovernanceRefusalError, isPathProtected } from "./governanceRefusal";
import { loadConfig } from "./config";

function ensureNotProtected(repoRoot: string, targetPath: string, system: string, requestedAction: string): void {
    const cfg = loadConfig(repoRoot);
    const protectedPaths = cfg.governance.protectedPaths;

    if (isPathProtected(repoRoot, targetPath, protectedPaths ?? [])) {
        throw new GovernanceRefusalError({
            system,
            requestedAction,
            refusalReason: "LEDGER_PROTECTION",
            policyRefs: ["governance.protectedPaths", "kintsugi:protectedPaths"],
            riskLevel: "CRITICAL",
            whatWouldBeRequired: "Choose a non-protected target path; audit/ledger/policy paths are not writable",
            notes: `Blocked write to protected path: ${path.resolve(targetPath)}`,
        });
    }
}

export function guardedMkdir(repoRoot: string, dirPath: string, system: string, requestedAction: string): void {
    ensureNotProtected(repoRoot, dirPath, system, requestedAction);
    fs.mkdirSync(dirPath, { recursive: true });
}

export function guardedWriteFile(repoRoot: string, filePath: string, data: string | Buffer, system: string, requestedAction: string): void {
    ensureNotProtected(repoRoot, filePath, system, requestedAction);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, data);
}

export function guardedWriteFileExclusive(
    repoRoot: string,
    filePath: string,
    data: string | Buffer,
    system: string,
    requestedAction: string
): void {
    ensureNotProtected(repoRoot, filePath, system, requestedAction);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, data, { flag: "wx" });
}

export function guardedCopyFile(repoRoot: string, src: string, dest: string, system: string, requestedAction: string): void {
    ensureNotProtected(repoRoot, dest, system, requestedAction);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
}

export function guardedRename(repoRoot: string, src: string, dest: string, system: string, requestedAction: string): void {
    ensureNotProtected(repoRoot, dest, system, requestedAction);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.renameSync(src, dest);
}
