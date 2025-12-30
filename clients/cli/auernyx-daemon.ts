#!/usr/bin/env node

import { startDaemon } from "../../core/server";

function parseArgs(argv: string[]): { repoRoot?: string } {
    const args = argv.slice(2);
    for (let i = 0; i < args.length; i++) {
        if (args[i] === "--root" && typeof args[i + 1] === "string") {
            return { repoRoot: args[i + 1] };
        }
    }
    return {};
}

function main() {
    const parsed = parseArgs(process.argv);
    const repoRoot = parsed.repoRoot ?? process.cwd();
    startDaemon(repoRoot);
}

main();
