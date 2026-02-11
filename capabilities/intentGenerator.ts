import type { RouterContext } from "../core/router";
import { execFileSync } from "child_process";
import * as path from "path";

interface IntentGeneratorParams {
    commitSha?: string;
    scan?: boolean;
    actorId?: string;
}

function isIntentGeneratorParams(obj: unknown): obj is IntentGeneratorParams {
    if (typeof obj !== "object" || obj === null) {
        return false;
    }
    const params = obj as Record<string, unknown>;
    return (
        (params.commitSha === undefined || typeof params.commitSha === "string") &&
        (params.scan === undefined || typeof params.scan === "boolean") &&
        (params.actorId === undefined || typeof params.actorId === "string")
    );
}

export async function intentGenerator(ctx: RouterContext, input?: unknown): Promise<unknown> {
    const scriptPath = path.join(ctx.repoRoot, "tools", "intent_generator.py");
    
    // Validate and extract parameters with type guard
    if (input !== undefined && !isIntentGeneratorParams(input)) {
        return {
            ok: false,
            error: "Invalid input parameters. Expected: { commitSha?: string, scan?: boolean, actorId?: string }"
        };
    }
    
    const params = (input || {}) as IntentGeneratorParams;
    const commitSha = params.commitSha;
    const scan = params.scan;
    const actorId = params.actorId || "intent-generator";
    
    // Validate commitSha format if provided (defense in depth)
    if (commitSha) {
        // Git SHA: 40 hex chars (full) or 7-40 hex chars (short)
        const shaPattern = /^[0-9a-f]{7,40}$/i;
        if (!shaPattern.test(commitSha)) {
            return {
                ok: false,
                error: "Invalid commitSha format. Expected 7-40 hexadecimal characters."
            };
        }
    }
    
    // Validate actorId contains only safe characters
    if (actorId) {
        // Allow alphanumeric, dash, underscore, and dot (common in usernames)
        const actorPattern = /^[a-zA-Z0-9._-]+$/;
        if (!actorPattern.test(actorId)) {
            return {
                ok: false,
                error: "Invalid actorId format. Only alphanumeric characters, dash, underscore, and dot are allowed."
            };
        }
    }
    
    const args: string[] = [scriptPath];
    
    if (scan) {
        args.push("--scan");
    } else if (commitSha) {
        args.push("--commit", commitSha);
        args.push("--actor-id", actorId);
    } else {
        return {
            ok: false,
            error: "Must specify either 'commitSha' or 'scan' option"
        };
    }
    
    try {
        const output = execFileSync("python3", args, {
            cwd: ctx.repoRoot,
            encoding: "utf-8",
            maxBuffer: 10 * 1024 * 1024 // 10MB
        });
        
        return {
            ok: true,
            output: output
        };
    } catch (error: any) {
        return {
            ok: false,
            error: error.message,
            stdout: error.stdout?.toString(),
            stderr: error.stderr?.toString()
        };
    }
}
