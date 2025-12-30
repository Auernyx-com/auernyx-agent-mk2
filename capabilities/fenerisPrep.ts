import * as fs from "fs";
import * as path from "path";
import type { RouterContext } from "../core/router";

export async function fenerisPrep(ctx: RouterContext, _input?: unknown): Promise<{ targetDir: string }> {
    const targetDir = path.join(ctx.repoRoot, "feneris-windows");
    if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });

    const core = `
# Feneris Windows Watchdog – Initialization Template
# Author: Architect
# Purpose: Windows-native watchdog skeleton

Start-Transcript -Path "$env:ProgramData\\Feneris\\logs\\init.log" -Append

Write-Output "Feneris initialization started."

# Insert ported logic here

Stop-Transcript
`;

    fs.writeFileSync(path.join(targetDir, "init.ps1"), core, "utf8");
    return { targetDir };
}
