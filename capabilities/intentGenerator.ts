import type { RouterContext } from "../core/router";
import { execFileSync } from "child_process";
import * as path from "path";

export async function intentGenerator(ctx: RouterContext, input?: unknown): Promise<unknown> {
    const scriptPath = path.join(ctx.repoRoot, "tools", "intent_generator.py");
    
    // Type guard and extract parameters
    const params = input as any || {};
    const commitSha = params.commitSha as string | undefined;
    const scan = params.scan as boolean | undefined;
    const actorId = (params.actorId as string) || "intent-generator";
    
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
