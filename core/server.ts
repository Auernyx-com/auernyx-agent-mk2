import { capabilityRequiresApproval, createPolicy, getCapabilityMeta, loadAllowlist } from "./policy";
import { createState } from "./state";
import { Ledger } from "./ledger";
import { createRouter, Router } from "./router";
import { loadConfig } from "./config";
import { ApprovalRequiredError, isValidApproval } from "./approvals";

import * as http from "http";
import * as os from "os";
import * as crypto from "crypto";

import { scanRepo } from "../capabilities/scanRepo";
import { fenerisPrep } from "../capabilities/fenerisPrep";
import { baselinePre } from "../capabilities/baselinePre";
import { baselinePost } from "../capabilities/baselinePost";
import { docker } from "../capabilities/docker";
import { memoryCheck } from "../capabilities/memoryCheck";
import { proposeFixes } from "../capabilities/proposeFixes";
import { governanceSelfTest } from "../capabilities/governanceSelfTest";
import { governanceUnlock } from "../capabilities/governanceUnlock";
import { rollbackKnownGood } from "../capabilities/rollbackKnownGood";
import { skjoldrFirewallStatus } from "../capabilities/skjoldrFirewallStatus";
import { skjoldrFirewallApplyProfile } from "../capabilities/skjoldrFirewallApplyProfile";
import { skjoldrFirewallApplyRulesetFile } from "../capabilities/skjoldrFirewallApplyRulesetFile";
import { skjoldrFirewallExportBaseline } from "../capabilities/skjoldrFirewallExportBaseline";
import { skjoldrFirewallRestoreBaseline } from "../capabilities/skjoldrFirewallRestoreBaseline";

import * as fs from "fs";
import * as path from "path";
import { getKintsugiPolicy, policyHash, verifyKintsugiIntegrity } from "./kintsugi/memory";

function daemonLockPathForRepo(repoRoot: string): string {
    const normalized = path.resolve(repoRoot).toLowerCase();
    const hash = crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 16);
    return path.join(os.tmpdir(), `auernyx-mk2-daemon-${hash}.lock`);
}

function tryReadPid(lockPath: string): number | undefined {
    try {
        const raw = fs.readFileSync(lockPath, "utf8").trim();
        const pid = Number(raw.split(/\s+/)[0]);
        return Number.isFinite(pid) && pid > 0 ? pid : undefined;
    } catch {
        return undefined;
    }
}

function isProcessAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

function acquireSingleInstanceLock(repoRoot: string): { lockPath: string; release: () => void } {
    const lockPath = daemonLockPathForRepo(repoRoot);
    try {
        const fd = fs.openSync(lockPath, "wx");
        fs.writeFileSync(fd, `${process.pid} ${new Date().toISOString()}`);
        fs.closeSync(fd);
    } catch {
        const pid = tryReadPid(lockPath);
        if (typeof pid === "number" && isProcessAlive(pid)) {
            throw new Error("daemon_already_running");
        }
        // Stale lock: remove and retry once.
        try {
            fs.unlinkSync(lockPath);
        } catch {
            // ignore
        }
        const fd = fs.openSync(lockPath, "wx");
        fs.writeFileSync(fd, `${process.pid} ${new Date().toISOString()}`);
        fs.closeSync(fd);
    }

    let released = false;
    const release = () => {
        if (released) return;
        released = true;
        try {
            fs.unlinkSync(lockPath);
        } catch {
            // ignore
        }
    };

    return { lockPath, release };
}

export interface AuernyxCore {
    router: Router;
    ledger: Ledger;
    sessionId: string;
}

export function createCore(repoRoot: string): AuernyxCore {
    const state = createState();
    const policy = createPolicy(repoRoot);
    const cfg = loadConfig(repoRoot);
    const ledger = new Ledger(repoRoot, { writeEnabled: cfg.writeEnabled });

    const router = createRouter(policy, {
        scanRepo,
        fenerisPrep,
        baselinePre,
        baselinePost,
        docker,

        memoryCheck,
        proposeFixes,
        governanceSelfTest,
        governanceUnlock,
        rollbackKnownGood,

        skjoldrFirewallStatus,
        skjoldrFirewallApplyProfile,
        skjoldrFirewallApplyRulesetFile,
        skjoldrFirewallExportBaseline,
        skjoldrFirewallRestoreBaseline
    });

    ledger.append(state.sessionId, "core.start", { repoRoot });

    return {
        router,
        ledger,
        sessionId: state.sessionId
    };
}

export interface DaemonRunRequest {
    intent: string;
    input?: unknown;
    approval?: unknown;
}

export interface DaemonRunResponse {
    ok: boolean;
    capability?: string;
    result?: unknown;
    error?: string;
    hints?: unknown;
}

function normalizeIntent(raw: string): string {
    return raw.trim().toLowerCase();
}

function isMetaIntent(text: string): boolean {
    return (
        text === "ping" ||
        text === "health" ||
        text === "help" ||
        text === "capabilities" ||
        text === "list" ||
        text === "status"
    );
}

function getMetaResult(repoRoot: string, sessionId: string, rawIntent: string): unknown {
    const text = normalizeIntent(rawIntent);
    if (text === "ping") {
        return { pong: true };
    }
    if (text === "health" || text === "status") {
        return { ok: true, sessionId };
    }
    // help/capabilities/list
    const allowlist = loadAllowlist(repoRoot);
    const capabilities = allowlist.allowedCapabilities.map((name) => {
        const meta = getCapabilityMeta(name);
        return {
            name: meta.name,
            readOnly: meta.readOnly,
            tier: meta.tier,
            requiresApproval: capabilityRequiresApproval(meta.name)
        };
    });

    return {
        capabilities,
        routingExamples: [
            "scan",
            "scan <path>",
            "feneris",
            "baseline pre",
            "baseline post",
            "memory",
            "governance self-test",
            "governance unlock",
            "rollback known good",
            "skjoldr status",
            "docker"
        ],
        notes: {
            approvals: "All capabilities require a human approval payload.",
            healthCheck: "Use GET /health for daemon liveness. POST /run with intent=health is also supported."
        }
    };
}

function readJson(req: http.IncomingMessage, maxBodyBytes: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        let total = 0;
        const limit = Number.isFinite(maxBodyBytes) && maxBodyBytes > 0 ? maxBodyBytes : 64 * 1024;

        req.on("data", (c) => {
            const buf = Buffer.isBuffer(c) ? c : Buffer.from(c);
            total += buf.length;
            if (total > limit) {
                reject(new Error("payload_too_large"));
                return;
            }
            chunks.push(buf);
        });
        req.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8").trim();
            if (!raw) return resolve({});
            try {
                resolve(JSON.parse(raw));
            } catch (e) {
                reject(e);
            }
        });
        req.on("error", reject);
    });
}

function uiHtml(): string {
        return `<!doctype html>
<html lang="en">
    <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Auernyx Mk2</title>
        <style>
            :root { color-scheme: light dark; }
            body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; margin: 16px; }
            h1 { margin: 0 0 8px 0; font-size: 18px; }
            .row { display: grid; grid-template-columns: 140px 1fr; gap: 8px; align-items: center; margin: 8px 0; }
            input, textarea, button { font: inherit; }
            input, textarea { width: 100%; padding: 8px; }
            textarea { min-height: 120px; }
            .buttons { display: flex; gap: 8px; flex-wrap: wrap; margin: 12px 0; }
            .hint { font-size: 12px; opacity: 0.8; }
            pre { white-space: pre-wrap; word-break: break-word; padding: 12px; border: 1px solid rgba(127,127,127,0.35); }
            code { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
        </style>
    </head>
    <body>
        <h1>Auernyx Mk2 (Daemon UI)</h1>
        <div class="hint">Read-only by default. Enable writes with <code>AUERNYX_WRITE_ENABLED=1</code>.</div>

        <div class="row">
            <label for="secret">Secret</label>
            <input id="secret" placeholder="Optional (x-auernyx-secret)" />
        </div>

        <div class="row">
            <label for="intent">Intent</label>
            <input id="intent" placeholder="e.g. memory, scan, propose fixes" />
        </div>

        <div class="row">
            <label for="inputJson">Input JSON</label>
            <textarea id="inputJson" placeholder='Optional JSON, e.g. {"targetDir":"."}'></textarea>
        </div>

        <div class="row">
            <label for="approvalReason">Approval reason</label>
            <input id="approvalReason" placeholder="Required for all capabilities" />
        </div>

        <div class="row">
            <label for="approvalIdentity">Approver identity</label>
            <input id="approvalIdentity" placeholder="Optional (if configured)" />
        </div>

        <div class="row">
            <label for="approvalConfirm">Confirm</label>
            <input id="approvalConfirm" placeholder='Type APPLY for controlled ops (if required)' />
        </div>

        <div class="buttons">
            <button id="run">Run</button>
            <button id="capabilities">Capabilities</button>
            <button id="config">Config</button>
            <button id="ledger">Ledger (tail)</button>
        </div>

        <pre id="out">Ready.</pre>

        <script>
            const el = (id) => document.getElementById(id);
            const out = el('out');
            const secretEl = el('secret');
            const intentEl = el('intent');
            const inputEl = el('inputJson');
            const reasonEl = el('approvalReason');
            const identEl = el('approvalIdentity');
            const confirmEl = el('approvalConfirm');

            secretEl.value = localStorage.getItem('auernyx.secret') || '';
            secretEl.addEventListener('input', () => localStorage.setItem('auernyx.secret', secretEl.value));

            function setOut(obj) {
                out.textContent = typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2);
            }

            function buildApproval() {
                const reason = (reasonEl.value || '').trim();
                if (!reason) return null;

                const identity = (identEl.value || '').trim();
                const confirm = (confirmEl.value || '').trim();

                return {
                    kind: 'human',
                    ts: new Date().toISOString(),
                    reason,
                    identity: identity || undefined,
                    confirm: confirm || undefined
                };
            }

            function buildInput() {
                const raw = (inputEl.value || '').trim();
                if (!raw) return undefined;
                return JSON.parse(raw);
            }

            async function postRun(intent, input, approval) {
                const secret = (secretEl.value || '').trim();
                const headers = { 'content-type': 'application/json' };
                if (secret) headers['x-auernyx-secret'] = secret;
                const res = await fetch('/run', {
                    method: 'POST',
                    headers,
                    body: JSON.stringify({ intent, input, approval })
                });
                const json = await res.json().catch(() => ({ ok: false, error: 'bad_json_response' }));
                return { status: res.status, json };
            }

            async function getJson(url) {
                const secret = (secretEl.value || '').trim();
                const headers = {};
                if (secret) headers['x-auernyx-secret'] = secret;
                const res = await fetch(url, { headers });
                const json = await res.json().catch(() => ({ ok: false, error: 'bad_json_response' }));
                return { status: res.status, json };
            }

            el('run').addEventListener('click', async () => {
                try {
                    const intent = (intentEl.value || '').trim();
                    if (!intent) return setOut('Missing intent.');
                    const input = buildInput();
                    const approval = buildApproval();
                    const resp = await postRun(intent, input, approval);
                    setOut(resp);
                } catch (e) {
                    setOut(String(e && e.message ? e.message : e));
                }
            });

            el('capabilities').addEventListener('click', async () => {
                const resp = await postRun('capabilities', undefined, buildApproval());
                setOut(resp);
            });

            el('config').addEventListener('click', async () => {
                const resp = await getJson('/config');
                setOut(resp);
            });

            el('ledger').addEventListener('click', async () => {
                const resp = await getJson('/ledger?tail=50');
                setOut(resp);
            });
        </script>
    </body>
</html>`;
}

function writeJson(res: http.ServerResponse, status: number, body: unknown) {
    const data = JSON.stringify(body);
    res.writeHead(status, {
        "content-type": "application/json; charset=utf-8",
        "content-length": Buffer.byteLength(data)
    });
    res.end(data);
}

function getHeader(req: http.IncomingMessage, name: string): string | undefined {
    const header = req.headers[name.toLowerCase()];
    return Array.isArray(header) ? header[0] : header;
}

function requireSecretIfConfigured(req: http.IncomingMessage, res: http.ServerResponse, secret: string): boolean {
    if (secret.trim().length === 0) return true;
    const provided = getHeader(req, "x-auernyx-secret");
    if (typeof provided !== "string" || provided !== secret) {
        writeJson(res, 401, { ok: false, error: "unauthorized" } satisfies DaemonRunResponse);
        return false;
    }
    return true;
}

function toInt(value: unknown, fallback: number): number {
    const n = typeof value === "string" ? Number(value) : typeof value === "number" ? value : NaN;
    return Number.isFinite(n) ? n : fallback;
}

function redact(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(redact);
    if (!value || typeof value !== "object") return value;

    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
        const key = k.toLowerCase();
        if (key.includes("secret") || key === "x-auernyx-secret" || key === "authorization") {
            out[k] = "[REDACTED]";
            continue;
        }
        out[k] = redact(v);
    }
    return out;
}

function readTailLines(filePath: string, maxLines: number): string[] {
    const linesWanted = Math.max(1, Math.min(maxLines, 1000));
    if (!fs.existsSync(filePath)) return [];

    const stat = fs.statSync(filePath);
    const size = stat.size;
    if (size <= 0) return [];

    // Read the last chunk(s) of the file (avoid loading huge ledgers fully).
    const chunkSize = 1024 * 1024; // 1MB
    const readSize = Math.min(size, chunkSize);
    const fd = fs.openSync(filePath, "r");
    try {
        const buf = Buffer.alloc(readSize);
        fs.readSync(fd, buf, 0, readSize, Math.max(0, size - readSize));
        const text = buf.toString("utf8");
        const all = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
        return all.slice(-linesWanted);
    } finally {
        fs.closeSync(fd);
    }
}

export function startDaemon(repoRoot: string) {
    const instance = acquireSingleInstanceLock(repoRoot);
    const cfg = loadConfig(repoRoot);
    const host = process.env.AUERNYX_HOST ?? cfg.daemon.host;
    const port = process.env.AUERNYX_PORT ? Number(process.env.AUERNYX_PORT) : cfg.daemon.port;
    const secret = process.env.AUERNYX_SECRET ?? (cfg.daemon.secret ?? "");
    const maxBodyBytes = Number(process.env.AUERNYX_MAX_BODY_BYTES ?? cfg.daemon.maxBodyBytes ?? 65536);

    const windowMs = Number(process.env.AUERNYX_RATE_WINDOW_MS ?? cfg.daemon.rateLimit?.windowMs ?? 10_000);
    const maxRequests = Number(process.env.AUERNYX_RATE_MAX ?? cfg.daemon.rateLimit?.maxRequests ?? 30);
    const rateState = new Map<string, { start: number; count: number }>();

    function checkRateLimit(req: http.IncomingMessage, res: http.ServerResponse): boolean {
        const ip = req.socket.remoteAddress ?? "unknown";
        const now = Date.now();
        const state = rateState.get(ip);
        if (!state || now - state.start > windowMs) {
            rateState.set(ip, { start: now, count: 1 });
            return true;
        }

        state.count += 1;
        if (state.count > maxRequests) {
            writeJson(res, 429, { ok: false, error: "rate_limited" } satisfies DaemonRunResponse);
            return false;
        }
        return true;
    }

    const core = createCore(repoRoot);
    core.ledger.append(core.sessionId, "daemon.start", { host, port, repoRoot });

    const server = http.createServer(async (req, res) => {
        if (!req.url || !req.method) {
            return writeJson(res, 400, { ok: false, error: "bad request" } satisfies DaemonRunResponse);
        }

        if (req.method === "GET" && req.url === "/") {
            return writeJson(res, 200, {
                ok: true,
                service: "auernyx-mk2-daemon",
                ui: "/ui",
                health: "/health",
            });
        }

        if (req.method === "GET" && req.url === "/ui") {
            const html = uiHtml();
            res.writeHead(200, {
                "content-type": "text/html; charset=utf-8",
                "content-length": Buffer.byteLength(html)
            });
            res.end(html);
            return;
        }

        if (req.method === "GET" && req.url === "/health") {
            return writeJson(res, 200, { ok: true });
        }

        if (req.method === "GET" && req.url.startsWith("/ledger")) {
            if (!checkRateLimit(req, res)) return;
            if (!requireSecretIfConfigured(req, res, secret)) return;

            const url = new URL(req.url, `http://${host}:${port}`);
            const tail = toInt(url.searchParams.get("tail"), 50);
            const ledgerPath = path.join(repoRoot, "logs", "ledger.ndjson");

            const lines = readTailLines(ledgerPath, tail);
            const entries: unknown[] = [];
            for (const line of lines) {
                try {
                    entries.push(redact(JSON.parse(line)));
                } catch {
                    // skip malformed line
                }
            }
            return writeJson(res, 200, { ok: true, count: entries.length, entries });
        }

        if (req.method === "GET" && req.url.startsWith("/config")) {
            if (!checkRateLimit(req, res)) return;
            if (!requireSecretIfConfigured(req, res, secret)) return;

            const allowlist = loadAllowlist(repoRoot);
            const kintsugiPolicy = getKintsugiPolicy(repoRoot);
            const kintsugi = {
                policy: kintsugiPolicy,
                policyHash: policyHash(kintsugiPolicy),
                integrity: await verifyKintsugiIntegrity(repoRoot, { initializePolicy: false }),
            };
            const effective = {
                repoRoot,
                daemon: {
                    host,
                    port,
                    secretEnabled: secret.trim().length > 0,
                    maxBodyBytes,
                    rateLimit: {
                        windowMs,
                        maxRequests
                    }
                },
                paths: {
                    scanAllowedRoots: cfg.paths.scanAllowedRoots
                },
                allowlist,
                kintsugi
            };

            return writeJson(res, 200, { ok: true, result: redact(effective) } satisfies DaemonRunResponse);
        }

        if (req.method === "POST" && req.url === "/run") {
            try {
                if (!checkRateLimit(req, res)) return;

                // Optional shared-secret auth (protects against random local processes).
                if (!requireSecretIfConfigured(req, res, secret)) return;

                const body = (await readJson(req, maxBodyBytes)) as Partial<DaemonRunRequest>;
                const intent = typeof body.intent === "string" ? body.intent : "";
                if (!intent.trim()) {
                    return writeJson(res, 400, { ok: false, error: "missing intent" } satisfies DaemonRunResponse);
                }

                const normalized = normalizeIntent(intent);
                if (isMetaIntent(normalized)) {
                    const result = getMetaResult(repoRoot, core.sessionId, intent);
                    core.ledger.append(core.sessionId, "daemon.meta", { intent: normalized, result });
                    return writeJson(res, 200, { ok: true, result } satisfies DaemonRunResponse);
                }

                const capability = core.router.route({ raw: intent });
                if (!capability) {
                    core.ledger.append(core.sessionId, "daemon.unroutable", { intent });
                    return writeJson(
                        res,
                        422,
                        {
                            ok: false,
                            error: "unroutable intent",
                            hints: {
                                health: "GET /health",
                                metaIntents: ["ping", "health", "help", "capabilities"],
                                routableExamples: [
                                    "scan",
                                    "scan <path>",
                                    "feneris",
                                    "baseline pre",
                                    "baseline post",
                                    "memory",
                                    "governance self-test",
                                    "governance unlock",
                                    "rollback known good",
                                    "skjoldr status",
                                    "docker"
                                ]
                            }
                        } satisfies DaemonRunResponse
                    );
                }

                const approval = isValidApproval(body.approval) ? body.approval : undefined;
                const result = await core.router.run(
                    capability,
                    { repoRoot, sessionId: core.sessionId, ledger: core.ledger },
                    body.input,
                    approval
                );
                core.ledger.append(core.sessionId, "daemon.run", { intent, capability, result });
                return writeJson(res, 200, { ok: true, capability, result } satisfies DaemonRunResponse);
            } catch (err) {
                if (err instanceof Error && err.message === "payload_too_large") {
                    return writeJson(res, 413, { ok: false, error: "payload_too_large" } satisfies DaemonRunResponse);
                }
                if (err instanceof ApprovalRequiredError) {
                    core.ledger.append(core.sessionId, "daemon.approval_required", { capability: err.capability });
                    return writeJson(res, 428, { ok: false, capability: err.capability, error: "approval_required" } satisfies DaemonRunResponse);
                }
                const msg = err instanceof Error ? err.message : String(err);
                core.ledger.append(core.sessionId, "daemon.error", { error: msg });
                return writeJson(res, 500, { ok: false, error: msg } satisfies DaemonRunResponse);
            }
        }

        return writeJson(res, 404, { ok: false, error: "not found" } satisfies DaemonRunResponse);
    });

    server.listen(port, host, () => {
        // Deterministic, short status line.
        // eslint-disable-next-line no-console
        console.log(`Auernyx daemon listening on http://${host}:${port}`);
    });

    const cleanup = () => {
        try {
            server.close();
        } catch {
            // ignore
        }
        instance.release();
    };

    process.once("exit", cleanup);
    process.once("SIGINT", () => {
        cleanup();
        process.exit(0);
    });
    process.once("SIGTERM", () => {
        cleanup();
        process.exit(0);
    });

    return server;
}

function parseArgs(argv: string[]): { repoRoot?: string } {
    const args = argv.slice(2);
    for (let i = 0; i < args.length; i++) {
        if (args[i] === "--root" && typeof args[i + 1] === "string") {
            return { repoRoot: args[i + 1] };
        }
    }
    return {};
}

// If executed directly: `node dist/core/server.js [--root <path>]`
if (require.main === module) {
    const parsed = parseArgs(process.argv);
    const root = parsed.repoRoot ?? process.cwd();
    startDaemon(root);
}
