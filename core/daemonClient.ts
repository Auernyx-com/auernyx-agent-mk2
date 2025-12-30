import * as http from "http";
import { loadConfig } from "./config";

export interface DaemonRunResponse {
    ok: boolean;
    capability?: string;
    result?: unknown;
    error?: string;
}

export interface DaemonClientOptions {
    repoRoot: string;
    timeoutMs?: number;
}

function requestJson(
    opts: http.RequestOptions,
    body?: unknown,
    timeoutMs: number = 1500
): Promise<{ status: number; json: unknown }> {
    return new Promise((resolve, reject) => {
        const payload = body ? Buffer.from(JSON.stringify(body), "utf8") : undefined;

        const req = http.request(
            {
                ...opts,
                headers: {
                    "content-type": "application/json; charset=utf-8",
                    ...(payload ? { "content-length": payload.byteLength } : {}),
                    ...(opts.headers ?? {})
                }
            },
            (res) => {
                const chunks: Buffer[] = [];
                res.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
                res.on("end", () => {
                    const raw = Buffer.concat(chunks).toString("utf8").trim();
                    try {
                        resolve({ status: res.statusCode ?? 0, json: raw ? JSON.parse(raw) : {} });
                    } catch (e) {
                        reject(e);
                    }
                });
            }
        );

        req.setTimeout(timeoutMs, () => {
            req.destroy(new Error("timeout"));
        });

        req.on("error", reject);
        if (payload) req.write(payload);
        req.end();
    });
}

export function getDaemonAddress(repoRoot: string): { host: string; port: number } {
    const cfg = loadConfig(repoRoot);
    const host = process.env.AUERNYX_HOST ?? cfg.daemon.host;
    const port = process.env.AUERNYX_PORT ? Number(process.env.AUERNYX_PORT) : cfg.daemon.port;

    return {
        host,
        port: Number.isFinite(port) && port > 0 ? port : cfg.daemon.port
    };
}

function getDaemonSecret(repoRoot: string): string {
    const cfg = loadConfig(repoRoot);
    const secret = process.env.AUERNYX_SECRET ?? (cfg.daemon.secret ?? "");
    return typeof secret === "string" ? secret : "";
}

export async function tryRunViaDaemon(
    opts: DaemonClientOptions,
    intent: string,
    input?: unknown,
    approval?: unknown
): Promise<DaemonRunResponse | null> {
    const { host, port } = getDaemonAddress(opts.repoRoot);
    const secret = getDaemonSecret(opts.repoRoot);

    try {
        const { status, json } = await requestJson(
            {
                host,
                port,
                method: "POST",
                path: "/run"
                ,
                headers: secret.trim().length > 0 ? { "x-auernyx-secret": secret } : undefined
            },
            { intent, input, approval },
            opts.timeoutMs ?? 1500
        );

        if (typeof json !== "object" || json === null) return null;
        const resp = json as Partial<DaemonRunResponse>;

        // Treat non-2xx as a real response (not "daemon missing")
        if (status >= 400) {
            return {
                ok: false,
                capability: typeof resp.capability === "string" ? resp.capability : undefined,
                error: typeof resp.error === "string" ? resp.error : `HTTP ${status}`
            };
        }

        return {
            ok: Boolean(resp.ok),
            capability: typeof resp.capability === "string" ? resp.capability : undefined,
            result: resp.result,
            error: typeof resp.error === "string" ? resp.error : undefined
        };
    } catch {
        // Connection refused / timeout / no daemon.
        return null;
    }
}

export async function isDaemonHealthy(opts: DaemonClientOptions): Promise<boolean> {
    const { host, port } = getDaemonAddress(opts.repoRoot);

    try {
        const { status, json } = await requestJson(
            {
                host,
                port,
                method: "GET",
                path: "/health"
            },
            undefined,
            opts.timeoutMs ?? 750
        );

        if (status !== 200) return false;
        if (typeof json !== "object" || json === null) return false;
        return (json as { ok?: unknown }).ok === true;
    } catch {
        return false;
    }
}
