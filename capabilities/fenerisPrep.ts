import * as path from "path";
import type { RouterContext } from "../core/router";
import { guardedMkdir, guardedWriteFile } from "../core/guardedFs";

export async function fenerisPrep(ctx: RouterContext, _input?: unknown): Promise<{ targetDir: string }> {
    const targetDir = path.join(ctx.repoRoot, "feneris-windows");
    guardedMkdir(ctx.repoRoot, targetDir, "fenerisPrep", "mkdir feneris-windows");

    const core = `
# Feneris Windows Watchdog – Initialization Template
# Author: Architect
# Purpose: Windows-native watchdog skeleton

Start-Transcript -Path "$env:ProgramData\\Feneris\\logs\\init.log" -Append

Write-Output "Feneris initialization started."

# Insert ported logic here

Stop-Transcript
`;

    guardedWriteFile(ctx.repoRoot, path.join(targetDir, "init.ps1"), core, "fenerisPrep", "write init.ps1");
    return { targetDir };
}
