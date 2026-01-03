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
import { searchDocPreview } from "../capabilities/searchDocPreview";
import { searchDocApply } from "../capabilities/searchDocApply";
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
import { runLifecycle } from "./runLifecycle";
import { ensureGenesisRecord, verifyProvenance, activateJudgment, clearJudgment, appendProvenanceAudit } from "./provenance";

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

    // Startup provenance verification (behavior first).
    ensureGenesisRecord(repoRoot, { writeEnabled: cfg.writeEnabled });
    const prov = verifyProvenance(repoRoot);
    if (!prov.ok) {
        activateJudgment(repoRoot, prov);
        appendProvenanceAudit(repoRoot, { kind: "startup.provenance.fail", data: prov });
    } else {
        clearJudgment(repoRoot);
        appendProvenanceAudit(repoRoot, { kind: "startup.provenance.ok" });
    }

    const router = createRouter(policy, {
        scanRepo,
        searchDocPreview,
        searchDocApply,
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

    ledger.append(state.sessionId, "core.start", { repoRoot, provenance: prov.ok ? "PASS" : "FAIL" });

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
    stepApprovals?: unknown;
    evidence?: unknown;
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

function isSafeReceiptSegment(seg: string): boolean {
    if (!seg) return false;
    if (seg === "." || seg === "..") return false;
    if (seg.includes("\\") || seg.includes("/")) return false;
    // Conservative allowlist: keep it URL/path safe and filesystem friendly.
    return /^[A-Za-z0-9._-]{1,128}$/.test(seg);
}

function contentTypeForReceiptFile(name: string): string {
    const lower = name.toLowerCase();
    if (lower.endsWith(".json")) return "application/json; charset=utf-8";
    if (lower.endsWith(".ndjson")) return "application/x-ndjson; charset=utf-8";
    if (lower.endsWith(".sha256")) return "text/plain; charset=utf-8";
    return "application/octet-stream";
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
            <button id="plan">Plan</button>
            <button id="capabilities">Capabilities</button>
            <button id="config">Config</button>
            <button id="ledger">Ledger (tail)</button>
        </div>

        <div class="hint">Plan/Step: Use Plan to generate a deterministic plan, then Execute Step with a per-step approval.</div>

        <div class="row">
            <label for="stepId">Step ID</label>
            <input id="stepId" placeholder="e.g. step-1" />
        </div>

        <div class="buttons">
            <button id="execStep">Execute Step</button>
            <button id="approveExecStep1">Approve &amp; Execute Step-1</button>
        </div>

        <div class="row">
            <label for="receiptLimit">Receipt limit</label>
            <input id="receiptLimit" placeholder="25" />
        </div>

        <div class="row">
            <label for="receiptRunId">Receipt runId</label>
            <input id="receiptRunId" placeholder="e.g. 1735600000000-abcdef123456" />
        </div>

        <div class="row">
            <label for="receiptFile">Receipt file</label>
            <input id="receiptFile" placeholder="e.g. plan.json, result.json, events.ndjson" />
        </div>

        <div class="buttons">
            <button id="receiptsList">Receipts (list)</button>
            <button id="receiptsFiles">Receipt files</button>
            <button id="receiptsFetch">Receipt file (fetch)</button>
        </div>

        <div class="hint">Run History: pick a receipt and load key artifacts.</div>

        <div class="row">
            <label for="historyRunId">History runId</label>
            <select id="historyRunId"></select>
        </div>

        <div class="buttons">
            <button id="historyRefresh">History (refresh)</button>
            <button id="historyLoadPlan">History: plan.json</button>
            <button id="historyLoadFinal">History: final.json</button>
            <button id="historyLoadOutputs">History: outputs.json</button>
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
            const stepIdEl = el('stepId');
            const receiptLimitEl = el('receiptLimit');
            const receiptRunIdEl = el('receiptRunId');
            const receiptFileEl = el('receiptFile');
            const historyRunIdEl = el('historyRunId');

            let lastPlannedPlan = null;

            secretEl.value = localStorage.getItem('auernyx.secret') || '';
            secretEl.addEventListener('input', () => localStorage.setItem('auernyx.secret', secretEl.value));

            receiptLimitEl.value = localStorage.getItem('auernyx.receiptLimit') || '25';
            receiptLimitEl.addEventListener('input', () => localStorage.setItem('auernyx.receiptLimit', receiptLimitEl.value));

            receiptRunIdEl.value = localStorage.getItem('auernyx.receiptRunId') || '';
            receiptRunIdEl.addEventListener('input', () => localStorage.setItem('auernyx.receiptRunId', receiptRunIdEl.value));

            receiptFileEl.value = localStorage.getItem('auernyx.receiptFile') || '';
            receiptFileEl.addEventListener('input', () => localStorage.setItem('auernyx.receiptFile', receiptFileEl.value));

            stepIdEl.value = localStorage.getItem('auernyx.stepId') || 'step-1';
            stepIdEl.addEventListener('input', () => localStorage.setItem('auernyx.stepId', stepIdEl.value));

            historyRunIdEl.addEventListener('change', () => localStorage.setItem('auernyx.historyRunId', historyRunIdEl.value));

            function setHistoryOptions(runIds) {
                while (historyRunIdEl.firstChild) historyRunIdEl.removeChild(historyRunIdEl.firstChild);
                for (const r of runIds) {
                    const opt = document.createElement('option');
                    opt.value = r;
                    opt.textContent = r;
                    historyRunIdEl.appendChild(opt);
                }

                const saved = localStorage.getItem('auernyx.historyRunId') || '';
                if (saved && runIds.includes(saved)) historyRunIdEl.value = saved;
                if (!historyRunIdEl.value && runIds.length) historyRunIdEl.value = runIds[0];
            }

            function setOut(obj) {
                out.textContent = typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2);
            }

            function buildApproval() {
                const reason = (reasonEl.value || '').trim();
                if (!reason) return null;

                const identity = (identEl.value || '').trim();
                const confirm = (confirmEl.value || '').trim();

                return {
                    approvedBy: 'human',
                    at: new Date().toISOString(),
                    reason,
                    identity: identity || undefined,
                    confirm: confirm || undefined
                };
            }

            function extractFirstStep(planRespJson) {
                const plan = planRespJson && planRespJson.result ? planRespJson.result.plan : null;
                const step0 = plan && Array.isArray(plan.steps) ? plan.steps[0] : null;
                const stepId = step0 && typeof step0.id === 'string' ? step0.id : null;
                const stepType = step0 && typeof step0.type === 'string' ? step0.type : null;
                const requiresApply = stepType && stepType !== 'READ_ONLY';
                return { plan, step0, stepId, stepType, requiresApply };
            }

            function rememberPlan(planRespJson) {
                const plan = planRespJson && planRespJson.result ? planRespJson.result.plan : null;
                if (plan && Array.isArray(plan.steps)) {
                    lastPlannedPlan = plan;
                }
            }

            function findStepTypeInLastPlan(stepId) {
                if (!lastPlannedPlan || !Array.isArray(lastPlannedPlan.steps)) return null;
                const step = lastPlannedPlan.steps.find((s) => s && typeof s.id === 'string' && s.id === stepId);
                return step && typeof step.type === 'string' ? step.type : null;
            }

            async function getConfig() {
                const resp = await getJson('/config');
                return resp;
            }

            async function ensureIdentityIfConfigured() {
                const cfgResp = await getConfig();
                const expected = cfgResp && cfgResp.json && cfgResp.json.result && cfgResp.json.result.governance
                    ? (cfgResp.json.result.governance.approverIdentity || '')
                    : '';
                const needsIdentity = typeof expected === 'string' && expected.trim().length > 0;
                if (!needsIdentity) return { ok: true };
                const provided = (identEl.value || '').trim();
                if (!provided) return { ok: false, error: 'Approver identity is required by governance config.' };
                return { ok: true };
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

            async function postPlan(intent, input) {
                const secret = (secretEl.value || '').trim();
                const headers = { 'content-type': 'application/json' };
                if (secret) headers['x-auernyx-secret'] = secret;
                const res = await fetch('/plan', {
                    method: 'POST',
                    headers,
                    body: JSON.stringify({ intent, input })
                });
                const json = await res.json().catch(() => ({ ok: false, error: 'bad_json_response' }));
                return { status: res.status, json };
            }

            async function postStep(intent, input, stepId, approval) {
                const secret = (secretEl.value || '').trim();
                const headers = { 'content-type': 'application/json' };
                if (secret) headers['x-auernyx-secret'] = secret;
                const res = await fetch('/step', {
                    method: 'POST',
                    headers,
                    body: JSON.stringify({ intent, input, stepId, approval })
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

            async function getText(url) {
                const secret = (secretEl.value || '').trim();
                const headers = {};
                if (secret) headers['x-auernyx-secret'] = secret;
                const res = await fetch(url, { headers });
                const text = await res.text().catch(() => '');
                return { status: res.status, text };
            }

            async function refreshHistory() {
                const rawLimit = (receiptLimitEl.value || '').trim();
                const limit = rawLimit ? Number(rawLimit) : 25;
                const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(200, limit)) : 25;
                const resp = await getJson('/receipts?limit=' + safeLimit);
                const receipts = resp && resp.json ? resp.json.receipts : null;
                const runIds = Array.isArray(receipts)
                    ? receipts.map((r) => (r && typeof r.runId === 'string' ? r.runId : null)).filter(Boolean)
                    : [];
                setHistoryOptions(runIds);
                return resp;
            }

            async function loadHistoryFile(fileName) {
                const runId = (historyRunIdEl.value || '').trim();
                if (!runId) return setOut('No history runId selected.');
                const resp = await getText('/receipts/' + encodeURIComponent(runId) + '/' + encodeURIComponent(fileName));
                if (fileName.endsWith('.json')) {
                    try {
                        const parsed = JSON.parse(resp.text);
                        return setOut({ status: resp.status, runId, file: fileName, json: parsed });
                    } catch {
                        return setOut({ status: resp.status, runId, file: fileName, text: resp.text });
                    }
                }
                return setOut({ status: resp.status, runId, file: fileName, text: resp.text });
            }

            el('run').addEventListener('click', async () => {
                try {
                    const intent = (intentEl.value || '').trim();
                    if (!intent) return setOut('Missing intent.');
                    const input = buildInput();
                    const approval = buildApproval();
                    if (!approval) return setOut('Missing approval reason.');

                    const idCheck = await ensureIdentityIfConfigured();
                    if (!idCheck.ok) return setOut(idCheck.error);

                    const planResp = await postPlan(intent, input);
                    if (!planResp || !planResp.json || !planResp.json.ok) {
                        return setOut({ plan: planResp });
                    }

                    rememberPlan(planResp.json);

                    const extracted = extractFirstStep(planResp.json);
                    if (extracted.stepId) stepIdEl.value = extracted.stepId;
                    if (extracted.requiresApply) confirmEl.value = 'APPLY';

                    const stepId = (stepIdEl.value || '').trim() || 'step-1';
                    const stepResp = await postStep(intent, input, stepId, approval);
                    setOut({ plan: planResp, step: stepResp });
                } catch (e) {
                    setOut(String(e && e.message ? e.message : e));
                }
            });

            el('plan').addEventListener('click', async () => {
                try {
                    const intent = (intentEl.value || '').trim();
                    if (!intent) return setOut('Missing intent.');
                    const input = buildInput();
                    const resp = await postPlan(intent, input);
                    if (resp && resp.json && resp.json.ok) {
                        rememberPlan(resp.json);
                        const extracted = extractFirstStep(resp.json);
                        if (extracted.stepId) stepIdEl.value = extracted.stepId;
                        if (extracted.requiresApply) confirmEl.value = 'APPLY';
                    }
                    setOut(resp);
                } catch (e) {
                    setOut(String(e && e.message ? e.message : e));
                }
            });

            el('execStep').addEventListener('click', async () => {
                try {
                    const intent = (intentEl.value || '').trim();
                    if (!intent) return setOut('Missing intent.');
                    const stepId = (stepIdEl.value || '').trim();
                    if (!stepId) return setOut('Missing stepId.');
                    const input = buildInput();

                    const inferredType = findStepTypeInLastPlan(stepId);
                    if (inferredType && inferredType !== 'READ_ONLY') {
                        confirmEl.value = 'APPLY';
                    }
                    const approval = buildApproval();
                    if (!approval) return setOut('Missing approval reason.');

                    const idCheck = await ensureIdentityIfConfigured();
                    if (!idCheck.ok) return setOut(idCheck.error);

                    // Step execution requires APPLY for non-readonly operations.
                    const resp = await postStep(intent, input, stepId, approval);
                    setOut(resp);
                } catch (e) {
                    setOut(String(e && e.message ? e.message : e));
                }
            });

            el('approveExecStep1').addEventListener('click', async () => {
                try {
                    const intent = (intentEl.value || '').trim();
                    if (!intent) return setOut('Missing intent.');
                    const input = buildInput();

                    const approval = buildApproval();
                    if (!approval) return setOut('Missing approval reason.');

                    const idCheck = await ensureIdentityIfConfigured();
                    if (!idCheck.ok) return setOut(idCheck.error);

                    const planResp = await postPlan(intent, input);
                    if (!planResp || !planResp.json || !planResp.json.ok) {
                        return setOut({ plan: planResp });
                    }

                    rememberPlan(planResp.json);

                    const extracted = extractFirstStep(planResp.json);
                    const stepId = extracted.stepId || 'step-1';
                    stepIdEl.value = stepId;

                    if (extracted.requiresApply) {
                        confirmEl.value = 'APPLY';
                    }

                    const approval2 = buildApproval();
                    if (!approval2) return setOut('Missing approval reason.');

                    const stepResp = await postStep(intent, input, stepId, approval2);
                    setOut({ plan: planResp, step: stepResp });
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

            el('receiptsList').addEventListener('click', async () => {
                const rawLimit = (receiptLimitEl.value || '').trim();
                const limit = rawLimit ? Number(rawLimit) : 25;
                const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(200, limit)) : 25;
                const resp = await getJson('/receipts?limit=' + safeLimit);
                setOut(resp);
            });

            el('receiptsFiles').addEventListener('click', async () => {
                const runId = (receiptRunIdEl.value || '').trim();
                if (!runId) return setOut('Missing receipt runId.');
                const resp = await getJson('/receipts/' + encodeURIComponent(runId));
                setOut(resp);
            });

            el('receiptsFetch').addEventListener('click', async () => {
                const runId = (receiptRunIdEl.value || '').trim();
                const file = (receiptFileEl.value || '').trim();
                if (!runId) return setOut('Missing receipt runId.');
                if (!file) return setOut('Missing receipt file name.');
                const resp = await getText('/receipts/' + encodeURIComponent(runId) + '/' + encodeURIComponent(file));
                setOut(resp);
            });

            el('historyRefresh').addEventListener('click', async () => {
                const resp = await refreshHistory();
                setOut(resp);
            });

            el('historyLoadPlan').addEventListener('click', async () => loadHistoryFile('plan.json'));
            el('historyLoadFinal').addEventListener('click', async () => loadHistoryFile('final.json'));
            el('historyLoadOutputs').addEventListener('click', async () => loadHistoryFile('outputs.json'));

            // Best-effort initial history population.
            refreshHistory().catch(() => void 0);
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
                        const accept = String(req.headers["accept"] ?? "");
                        const userAgent = String(req.headers["user-agent"] ?? "");
                        const payload = {
                                ok: true,
                                service: "auernyx-mk2-daemon",
                                ui: "/ui",
                                health: "/health",
                        };

                        const url = new URL(req.url, `http://${host}:${port}`);
                        const format = String(url.searchParams.get("format") ?? "").toLowerCase();
                        const wantsJson = format === "json" || accept.includes("application/json");
                        const looksLikeBrowser = accept.includes("text/html") || /Mozilla\//i.test(userAgent);

                        // Human-friendly default for browsers.
                        if (!wantsJson && looksLikeBrowser) {
                                const html = `<!doctype html>
<html lang="en">
    <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Auernyx Mk2 Daemon</title>
        <style>
            :root { color-scheme: light dark; }
            body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; margin: 16px; }
            h1 { margin: 0 0 8px 0; font-size: 18px; }
            .hint { font-size: 12px; opacity: 0.8; }
            code { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
            a { text-decoration: none; }
            details { margin-top: 12px; }
            pre { white-space: pre-wrap; word-break: break-word; padding: 12px; border: 1px solid rgba(127,127,127,0.35); }
        </style>
    </head>
    <body>
        <h1>Auernyx Mk2 Daemon</h1>
        <div class="hint">This endpoint is headless. Use the UI link below for a human-friendly page.</div>
        <ul>
            <li><a href="/ui">Open UI</a></li>
            <li><a href="/health">Health</a></li>
        </ul>
        <div class="hint">For JSON, request <code>Accept: application/json</code> or use <code>/?format=json</code>.</div>

        <details>
            <summary>Reveal JSON (unsafe)</summary>
            <div class="hint">This may expose proprietary structure. Prefer receipts for auditing.</div>
            <pre>${JSON.stringify(payload, null, 2)}</pre>
        </details>
    </body>
</html>`;
                                res.writeHead(200, {
                                        "content-type": "text/html; charset=utf-8",
                                        "content-length": Buffer.byteLength(html)
                                });
                                res.end(html);
                                return;
                        }

                        return writeJson(res, 200, payload);
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

        if (req.method === "GET" && req.url.startsWith("/receipts")) {
            if (!checkRateLimit(req, res)) return;
            if (!requireSecretIfConfigured(req, res, secret)) return;

            const url = new URL(req.url, `http://${host}:${port}`);
            const segments = url.pathname.split("/").filter(Boolean);
            // segments[0] === "receipts"
            const baseDir = path.join(repoRoot, ".auernyx", "receipts");

            if (segments.length === 1) {
                const limit = toInt(url.searchParams.get("limit"), 25);
                if (!fs.existsSync(baseDir)) {
                    return writeJson(res, 200, { ok: true, count: 0, receipts: [] });
                }

                const entries = fs
                    .readdirSync(baseDir, { withFileTypes: true })
                    .filter((d) => d.isDirectory() && isSafeReceiptSegment(d.name))
                    .map((d) => {
                        const dirPath = path.join(baseDir, d.name);
                        let mtimeMs = 0;
                        try {
                            mtimeMs = fs.statSync(dirPath).mtimeMs;
                        } catch {
                            // ignore
                        }
                        return { runId: d.name, mtimeMs };
                    })
                    .sort((a, b) => b.mtimeMs - a.mtimeMs)
                    .slice(0, Math.max(1, Math.min(200, limit)));

                return writeJson(res, 200, { ok: true, count: entries.length, receipts: entries });
            }

            const runId = segments[1] ?? "";
            if (!isSafeReceiptSegment(runId)) {
                return writeJson(res, 400, { ok: false, error: "invalid_receipt_id" } satisfies DaemonRunResponse);
            }

            const runDir = path.join(baseDir, runId);
            if (!fs.existsSync(runDir) || !fs.statSync(runDir).isDirectory()) {
                return writeJson(res, 404, { ok: false, error: "receipt_not_found" } satisfies DaemonRunResponse);
            }

            if (segments.length === 2) {
                const files = fs
                    .readdirSync(runDir, { withFileTypes: true })
                    .filter((d) => d.isFile() && isSafeReceiptSegment(d.name))
                    .map((d) => d.name)
                    .sort();
                return writeJson(res, 200, { ok: true, runId, files });
            }

            if (segments.length === 3) {
                const fileName = segments[2] ?? "";
                if (!isSafeReceiptSegment(fileName)) {
                    return writeJson(res, 400, { ok: false, error: "invalid_receipt_file" } satisfies DaemonRunResponse);
                }

                const filePath = path.join(runDir, fileName);
                let st: fs.Stats;
                try {
                    st = fs.statSync(filePath);
                } catch {
                    return writeJson(res, 404, { ok: false, error: "receipt_file_not_found" } satisfies DaemonRunResponse);
                }
                if (!st.isFile()) {
                    return writeJson(res, 404, { ok: false, error: "receipt_file_not_found" } satisfies DaemonRunResponse);
                }

                const maxBytes = 2 * 1024 * 1024;
                if (st.size > maxBytes) {
                    return writeJson(res, 413, { ok: false, error: "receipt_file_too_large" } satisfies DaemonRunResponse);
                }

                const body = fs.readFileSync(filePath);
                res.writeHead(200, {
                    "content-type": contentTypeForReceiptFile(fileName),
                    "content-length": body.length
                });
                res.end(body);
                return;
            }

            return writeJson(res, 404, { ok: false, error: "not found" } satisfies DaemonRunResponse);
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

                const approval = isValidApproval(body.approval) ? body.approval : undefined;
                const stepApprovals = Array.isArray(body.stepApprovals) ? (body.stepApprovals as any) : undefined;
                const evidence = Array.isArray(body.evidence) ? (body.evidence as any) : undefined;
                const lifecycle = await runLifecycle({
                    router: core.router,
                    ctx: { repoRoot, sessionId: core.sessionId, ledger: core.ledger },
                    intent,
                    input: body.input,
                    approval,
                    stepApprovals,
                    evidence,
                });

                if (!lifecycle.ok) {
                    core.ledger.append(core.sessionId, "daemon.refusal", {
                        intent,
                        capability: lifecycle.capability,
                        refusal: lifecycle.refusal,
                        receipt: lifecycle.receipt,
                    });

                    const status = lifecycle.refusal?.code === "step_approval_required" ? 428 : 422;
                    return writeJson(res, status, {
                        ok: false,
                        capability: lifecycle.capability,
                        error: lifecycle.refusal?.code ?? (lifecycle.refusal?.reason ?? "refused"),
                        hints: {
                            ...lifecycle.refusal,
                            plan: lifecycle.plan,
                            missingStepIds: lifecycle.missingStepIds,
                            receipt: lifecycle.receipt,
                        },
                    } satisfies DaemonRunResponse);
                }

                core.ledger.append(core.sessionId, "daemon.run", {
                    intent,
                    capability: lifecycle.capability,
                    receipt: lifecycle.receipt,
                });

                return writeJson(res, 200, {
                    ok: true,
                    capability: lifecycle.capability,
                    result: lifecycle.result,
                } satisfies DaemonRunResponse);
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

        if (req.method === "POST" && req.url === "/plan") {
            try {
                if (!checkRateLimit(req, res)) return;
                if (!requireSecretIfConfigured(req, res, secret)) return;

                const body = (await readJson(req, maxBodyBytes)) as Partial<DaemonRunRequest>;
                const intent = typeof body.intent === "string" ? body.intent : "";
                if (!intent.trim()) {
                    return writeJson(res, 400, { ok: false, error: "missing intent" } satisfies DaemonRunResponse);
                }

                const lifecycle = await runLifecycle({
                    router: core.router,
                    ctx: { repoRoot, sessionId: core.sessionId, ledger: core.ledger },
                    intent,
                    input: body.input,
                    // No approvals: force plan-only response.
                    stepApprovals: [],
                    evidence: Array.isArray(body.evidence) ? (body.evidence as any) : undefined,
                });

                // runLifecycle returns step_approval_required when approvals are missing; that is expected for /plan.
                if (lifecycle.plan) {
                    return writeJson(res, 200, {
                        ok: true,
                        capability: lifecycle.capability,
                        result: {
                            plan: lifecycle.plan,
                            missingStepIds: lifecycle.missingStepIds ?? [],
                            receipt: lifecycle.receipt,
                        }
                    } satisfies DaemonRunResponse);
                }

                return writeJson(res, 422, {
                    ok: false,
                    error: lifecycle.refusal?.code ?? (lifecycle.refusal?.reason ?? "refused"),
                    hints: lifecycle.refusal,
                } satisfies DaemonRunResponse);
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                return writeJson(res, 500, { ok: false, error: msg } satisfies DaemonRunResponse);
            }
        }

        if (req.method === "POST" && req.url === "/step") {
            try {
                if (!checkRateLimit(req, res)) return;
                if (!requireSecretIfConfigured(req, res, secret)) return;

                const body = (await readJson(req, maxBodyBytes)) as any;
                const intent = typeof body.intent === "string" ? body.intent : "";
                const stepId = typeof body.stepId === "string" ? body.stepId : "";
                if (!intent.trim()) return writeJson(res, 400, { ok: false, error: "missing intent" } satisfies DaemonRunResponse);
                if (!stepId.trim()) return writeJson(res, 400, { ok: false, error: "missing stepId" } satisfies DaemonRunResponse);

                const approval = body.approval;
                const evidence = Array.isArray(body.evidence) ? body.evidence : undefined;

                // Execute by providing a single step approval; runLifecycle will enforce plan-based execution.
                const evidenceRefs = Array.isArray((approval as any)?.evidenceRefs) ? ((approval as any).evidenceRefs as unknown[]) : undefined;
                const approvalForStep = isValidApproval(approval)
                    ? [{ ...(approval as any), stepId, evidenceRefs: evidenceRefs?.filter((v) => typeof v === "string" && v.trim().length > 0) }]
                    : [];

                const lifecycle = await runLifecycle({
                    router: core.router,
                    ctx: { repoRoot, sessionId: core.sessionId, ledger: core.ledger },
                    intent,
                    input: body.input,
                    executeStepId: stepId,
                    stepApprovals: approvalForStep,
                    evidence,
                });

                if (!lifecycle.ok) {
                    const status = lifecycle.refusal?.code === "step_approval_required" ? 428 : 422;
                    return writeJson(res, status, {
                        ok: false,
                        capability: lifecycle.capability,
                        error: lifecycle.refusal?.code ?? (lifecycle.refusal?.reason ?? "refused"),
                        hints: {
                            ...lifecycle.refusal,
                            plan: lifecycle.plan,
                            missingStepIds: lifecycle.missingStepIds,
                            receipt: lifecycle.receipt,
                        },
                    } satisfies DaemonRunResponse);
                }

                const outputs = Array.isArray(lifecycle.result) ? (lifecycle.result as any[]) : [];
                const executedCapability =
                    typeof outputs[0]?.tool?.name === "string" ? (outputs[0].tool.name as string) : lifecycle.capability;

                return writeJson(res, 200, {
                    ok: true,
                    capability: executedCapability,
                    result: { outputs: lifecycle.result, receipt: lifecycle.receipt, plan: lifecycle.plan },
                } satisfies DaemonRunResponse);
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
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
