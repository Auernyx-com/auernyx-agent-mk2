#!/usr/bin/env node

/**
 * Auernyx Mk2 - Headless Daemon Server
 * 
 * This is part of the headless agent (one of two independent agents in Mk2).
 * Provides:
 * - HTTP JSON API for programmatic access
 * - Browser UI at /ui endpoint
 * - CLI client support (auernyx.ts)
 * 
 * The daemon operates independently and does not require VS Code.
 */

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
