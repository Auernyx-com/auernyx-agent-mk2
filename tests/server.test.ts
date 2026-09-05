import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "fs";
import * as path from "path";
import {
  makeServerRepoRoot,
  makeGitRepoRoot,
  startTestDaemon,
  httpRequest,
  httpPostJson,
  validApproval,
} from "./helpers/testDaemon";

// startDaemon() registers its own process-level exit/SIGINT/SIGTERM cleanup
// listeners with no companion API to remove them — reasonable for its real
// use (one daemon per process, for the process's whole life), but this suite
// creates many daemon instances in a single test process, so they accumulate
// past Node's default max-listener warning threshold. Not a product bug
// (harmless here, and normal daemon usage never calls startDaemon more than
// once per process), just noise worth silencing rather than chasing.
process.setMaxListeners(200);

// First test coverage for core/server.ts (1500 lines, the HTTP daemon) — real
// end-to-end HTTP requests against a real startDaemon() instance on an
// ephemeral port, not unit-testing route handlers in isolation. Found and
// fixed 2 real bugs while writing these:
//
// 1. A malformed JSON request body on /run, /plan, or /step fell through to
//    the generic catch-all and came back as a 500 with the raw JSON.parse
//    error message — a client mistake (bad JSON) reported as a server
//    failure. Fixed: readRequestBody() now returns 400 invalid_json for a
//    parse failure, isolated to the body-parsing step specifically (not a
//    broad instanceof SyntaxError check across the whole handler, which
//    could misclassify an unrelated internal SyntaxError as a client error).
// 2. Only /run's catch block special-cased payload_too_large into a 413 —
//    /plan and /step had no such check, so the identical failure (a body
//    over maxBodyBytes) returned 500 there instead of 413. Verified directly:
//    sent the same oversized body to all three routes, only /run returned
//    413. Fixed by routing all three through the same readRequestBody().
//
// Also investigated and deliberately NOT fixed, documented instead: /receipts
// dispatches on `req.url.startsWith("/receipts")` (the raw string) but then
// parses path segments from `new URL(req.url, ...).pathname`, which the
// WHATWG URL parser dot-segment-normalizes *before* segment-safety checks
// ever run — confirmed directly that "/receipts/%2e%2e/%2e%2e/etc/passwd"
// normalizes to pathname "/etc/passwd" (segments ["etc","passwd"]), so the
// code's own "segments[0] === receipts" assumption can be violated by an
// attacker-supplied path. This is real routing confusion, but verified NOT
// exploitable: isSafeReceiptSegment() and path.join(baseDir, ...) still gate
// the actual filesystem access regardless of how segments[] got populated,
// and the crafted request above returns a plain 404, never real content.

function readSearchDocPath(repoRoot: string): string {
  return path.join(repoRoot, "docs", "SEARCH.md");
}

// ─── Meta intents via /run ──────────────────────────────────────────────────

test("/run with intent 'ping' returns the meta pong result with no approval needed", async () => {
  const repoRoot = makeServerRepoRoot();
  const daemon = await startTestDaemon(repoRoot);
  try {
    const r = await httpPostJson(daemon.port, "/run", { intent: "ping" });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { ok: true, result: { pong: true } });
  } finally {
    daemon.close();
  }
});

test("/run with intent 'help' lists exactly the allowed capabilities", async () => {
  const repoRoot = makeServerRepoRoot(["scanRepo", "memoryCheck"]);
  const daemon = await startTestDaemon(repoRoot);
  try {
    const r = await httpPostJson(daemon.port, "/run", { intent: "help" });
    assert.equal(r.status, 200);
    const names = ((r.json as any).result.capabilities as any[]).map((c) => c.name).sort();
    assert.deepEqual(names, ["memoryCheck", "scanRepo"]);
  } finally {
    daemon.close();
  }
});

test("/run with a missing intent returns 400", async () => {
  const repoRoot = makeServerRepoRoot();
  const daemon = await startTestDaemon(repoRoot);
  try {
    const r = await httpPostJson(daemon.port, "/run", {});
    assert.equal(r.status, 400);
    assert.deepEqual(r.json, { ok: false, error: "missing intent" });
  } finally {
    daemon.close();
  }
});

test("/run with an unroutable intent is refused with a 422, not a 500", async () => {
  const repoRoot = makeServerRepoRoot();
  const daemon = await startTestDaemon(repoRoot, { writeEnabled: true });
  try {
    const r = await httpPostJson(daemon.port, "/run", { intent: "gibberish nobody would say" });
    assert.equal(r.status, 422);
    assert.equal((r.json as any).ok, false);
  } finally {
    daemon.close();
  }
});

// ─── /health and /health/detail ─────────────────────────────────────────────

test("/health reports 503/OUT_OF_TOLERANCE on a fresh repo with no sealed genesis", async () => {
  const repoRoot = makeServerRepoRoot();
  const daemon = await startTestDaemon(repoRoot); // writeEnabled:false — genesis never seals
  try {
    const r = await httpRequest(daemon.port, "GET", "/health");
    assert.equal(r.status, 503);
    assert.equal((r.json as any).ok, false);
    assert.equal((r.json as any).tree.root, "OUT_OF_TOLERANCE");
  } finally {
    daemon.close();
  }
});

test("/health reports 200/WITHIN_TOLERANCE across the board once genesis is sealed", async () => {
  const repoRoot = makeServerRepoRoot();
  const daemon = await startTestDaemon(repoRoot, { writeEnabled: true });
  try {
    const r = await httpRequest(daemon.port, "GET", "/health");
    assert.equal(r.status, 200);
    assert.deepEqual((r.json as any).tree, {
      root: "WITHIN_TOLERANCE",
      trunk: "WITHIN_TOLERANCE",
      branch: "WITHIN_TOLERANCE",
      leaf: "WITHIN_TOLERANCE",
    });
  } finally {
    daemon.close();
  }
});

test("/health never requires the secret, even when one is configured", async () => {
  const repoRoot = makeServerRepoRoot();
  const daemon = await startTestDaemon(repoRoot, { secret: "s3cr3t" });
  try {
    const r = await httpRequest(daemon.port, "GET", "/health");
    assert.notEqual(r.status, 401);
  } finally {
    daemon.close();
  }
});

test("/health/detail does require the secret when one is configured, unlike plain /health", async () => {
  const repoRoot = makeServerRepoRoot();
  const daemon = await startTestDaemon(repoRoot, { secret: "s3cr3t", writeEnabled: true });
  try {
    const denied = await httpRequest(daemon.port, "GET", "/health/detail");
    assert.equal(denied.status, 401);

    const allowed = await httpRequest(daemon.port, "GET", "/health/detail", {
      headers: { "x-auernyx-secret": "s3cr3t" },
    });
    assert.equal(allowed.status, 200);
    assert.equal((allowed.json as any).tree.root.judgment_active, false);
  } finally {
    daemon.close();
  }
});

// ─── Secret auth enforcement ────────────────────────────────────────────────

test("protected GET routes (/ledger, /config, /receipts) all 401 without the configured secret", async () => {
  const repoRoot = makeServerRepoRoot();
  const daemon = await startTestDaemon(repoRoot, { secret: "s3cr3t" });
  try {
    for (const route of ["/ledger", "/config", "/receipts"]) {
      const r = await httpRequest(daemon.port, "GET", route);
      assert.equal(r.status, 401, `${route} should require the secret`);
    }
  } finally {
    daemon.close();
  }
});

test("protected POST routes (/run, /plan, /step) all 401 without the configured secret", async () => {
  const repoRoot = makeServerRepoRoot();
  const daemon = await startTestDaemon(repoRoot, { secret: "s3cr3t" });
  try {
    for (const route of ["/run", "/plan", "/step"]) {
      const r = await httpPostJson(daemon.port, route, { intent: "ping" });
      assert.equal(r.status, 401, `${route} should require the secret`);
    }
  } finally {
    daemon.close();
  }
});

test("the wrong secret is rejected the same as no secret at all", async () => {
  const repoRoot = makeServerRepoRoot();
  const daemon = await startTestDaemon(repoRoot, { secret: "s3cr3t" });
  try {
    const r = await httpRequest(daemon.port, "GET", "/config", { headers: { "x-auernyx-secret": "wrong" } });
    assert.equal(r.status, 401);
  } finally {
    daemon.close();
  }
});

test("with no secret configured, protected routes are open (single-machine dev default)", async () => {
  const repoRoot = makeServerRepoRoot();
  const daemon = await startTestDaemon(repoRoot); // no secret option
  try {
    const r = await httpRequest(daemon.port, "GET", "/config");
    assert.equal(r.status, 200);
  } finally {
    daemon.close();
  }
});

// ─── Rate limiting ───────────────────────────────────────────────────────────

test("rate limiting allows exactly maxRequests within the window, then 429s, shared per IP across protected routes", async () => {
  const repoRoot = makeServerRepoRoot();
  const daemon = await startTestDaemon(repoRoot, { rateMax: 3, rateWindowMs: 60_000 });
  try {
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await httpRequest(daemon.port, "GET", "/ledger");
      statuses.push(r.status);
    }
    assert.deepEqual(statuses, [200, 200, 200, 429, 429]);
  } finally {
    daemon.close();
  }
});

test("/health is never subject to rate limiting", async () => {
  const repoRoot = makeServerRepoRoot();
  const daemon = await startTestDaemon(repoRoot, { rateMax: 1, rateWindowMs: 60_000 });
  try {
    // Exhaust the tiny rate budget on a limited route first.
    await httpRequest(daemon.port, "GET", "/ledger");
    const exhausted = await httpRequest(daemon.port, "GET", "/ledger");
    assert.equal(exhausted.status, 429);

    const health = await httpRequest(daemon.port, "GET", "/health");
    assert.notEqual(health.status, 429);
  } finally {
    daemon.close();
  }
});

// ─── /ledger ────────────────────────────────────────────────────────────────

test("/ledger returns recorded entries and redacts a configured secret from them", async () => {
  const repoRoot = makeServerRepoRoot();
  const daemon = await startTestDaemon(repoRoot, { writeEnabled: true, secret: "topsecret" });
  try {
    // core.start and daemon.start are appended during startup.
    const r = await httpRequest(daemon.port, "GET", "/ledger", { headers: { "x-auernyx-secret": "topsecret" } });
    assert.equal(r.status, 200);
    assert.ok((r.json as any).count >= 1);

    const raw = JSON.stringify(r.json);
    assert.ok(!raw.includes("topsecret"), "the configured secret must never appear verbatim in ledger output");
  } finally {
    daemon.close();
  }
});

// ─── /config ────────────────────────────────────────────────────────────────

test("/config reports the effective daemon config and redacts the secret", async () => {
  const repoRoot = makeServerRepoRoot();
  const daemon = await startTestDaemon(repoRoot, { secret: "topsecret", writeEnabled: true });
  try {
    const r = await httpRequest(daemon.port, "GET", "/config", { headers: { "x-auernyx-secret": "topsecret" } });
    assert.equal(r.status, 200);
    assert.equal((r.json as any).result.daemon.secretEnabled, true);
    const raw = JSON.stringify(r.json);
    assert.ok(!raw.includes("topsecret"));
  } finally {
    daemon.close();
  }
});

// ─── /receipts ──────────────────────────────────────────────────────────────

test("/receipts lists nothing on a fresh repo", async () => {
  const repoRoot = makeServerRepoRoot();
  const daemon = await startTestDaemon(repoRoot);
  try {
    const r = await httpRequest(daemon.port, "GET", "/receipts");
    assert.deepEqual(r.json, { ok: true, count: 0, receipts: [] });
  } finally {
    daemon.close();
  }
});

test("/receipts lists a receipt after a run, its files can be listed, and one can be fetched", async () => {
  const repoRoot = makeServerRepoRoot();
  const daemon = await startTestDaemon(repoRoot, { writeEnabled: true });
  try {
    await httpPostJson(daemon.port, "/run", { intent: "scan the repo", approval: validApproval });

    const list = await httpRequest(daemon.port, "GET", "/receipts");
    assert.equal((list.json as any).count, 1);
    const runId = (list.json as any).receipts[0].runId;

    const files = await httpRequest(daemon.port, "GET", `/receipts/${runId}`);
    assert.equal(files.status, 200);
    assert.ok(Array.isArray((files.json as any).files));
    assert.ok((files.json as any).files.length > 0);

    const fileName = (files.json as any).files.find((f: string) => f.endsWith(".json"));
    const fetched = await httpRequest(daemon.port, "GET", `/receipts/${runId}/${fileName}`);
    assert.equal(fetched.status, 200);
    assert.equal(fetched.headers["content-type"], "application/json; charset=utf-8");
  } finally {
    daemon.close();
  }
});

test("/receipts rejects a receipt id containing unsafe characters with 400, not a filesystem error", async () => {
  const repoRoot = makeServerRepoRoot();
  const daemon = await startTestDaemon(repoRoot);
  try {
    const r = await httpRequest(daemon.port, "GET", "/receipts/foo@bar");
    assert.equal(r.status, 400);
    assert.equal((r.json as any).error, "invalid_receipt_id");
  } finally {
    daemon.close();
  }
});

test("/receipts 404s for a well-formed but nonexistent receipt id", async () => {
  const repoRoot = makeServerRepoRoot();
  const daemon = await startTestDaemon(repoRoot);
  try {
    const r = await httpRequest(daemon.port, "GET", "/receipts/does-not-exist-123");
    assert.equal(r.status, 404);
  } finally {
    daemon.close();
  }
});

test(
  "known, documented characteristic (not fixed — verified NOT exploitable): a dot-segment-encoded " +
    "/receipts path is normalized by the URL parser before segment parsing, so the code's own " +
    "'segments[0] === receipts' assumption can be violated, but isSafeReceiptSegment + path.join(baseDir,...) " +
    "still bound the actual filesystem access to a plain 404 rather than leaking anything",
  async () => {
    const repoRoot = makeServerRepoRoot();
    const daemon = await startTestDaemon(repoRoot);
    try {
      const r = await httpRequest(daemon.port, "GET", "/receipts/%2e%2e/%2e%2e/etc/passwd");
      assert.equal(r.status, 404);
      assert.ok(!r.bodyText.includes("root:"), "must never reflect real /etc/passwd content");
    } finally {
      daemon.close();
    }
  }
);

// ─── /plan and /step ────────────────────────────────────────────────────────

test("/plan generates a plan without requiring any approval", async () => {
  const repoRoot = makeServerRepoRoot();
  const daemon = await startTestDaemon(repoRoot, { writeEnabled: true });
  try {
    const r = await httpPostJson(daemon.port, "/plan", { intent: "scan the repo" });
    assert.equal(r.status, 200);
    assert.equal((r.json as any).result.plan.steps[0].tool.name, "scanRepo");
    assert.deepEqual((r.json as any).result.missingStepIds, ["step-1"]);
  } finally {
    daemon.close();
  }
});

test("/plan with a missing intent returns 400", async () => {
  const repoRoot = makeServerRepoRoot();
  const daemon = await startTestDaemon(repoRoot);
  try {
    const r = await httpPostJson(daemon.port, "/plan", {});
    assert.equal(r.status, 400);
  } finally {
    daemon.close();
  }
});

test("/step executes a targeted step of the real 2-step searchDoc plan end to end", async () => {
  const repoRoot = makeGitRepoRoot(["searchDocPreview", "searchDocApply"]);
  const daemon = await startTestDaemon(repoRoot, { writeEnabled: true });
  try {
    const step1 = await httpRequest(
      daemon.port,
      "POST",
      "/step",
      {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ intent: "search doc apply x", input: { action: "add", docPath: "docs/a.md" }, stepId: "step-1", approval: validApproval }),
      }
    );
    assert.equal(step1.status, 200);
    assert.equal((step1.json as any).capability, "searchDocPreview");
    assert.equal(fs.existsSync(readSearchDocPath(repoRoot)), false); // step-1 is preview-only, no write yet

    const step2 = await httpRequest(daemon.port, "POST", "/step", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        intent: "search doc apply x",
        input: { action: "add", docPath: "docs/a.md" },
        stepId: "step-2",
        approval: {
          ...validApproval,
          identity: "Test Approver",
          apply: true,
          confirm: "APPLY",
          evidenceRefs: ["ev-1"],
          acknowledgedRollbackPointIds: ["rb-1"],
        },
      }),
    });
    assert.equal(step2.status, 200);
    assert.equal((step2.json as any).capability, "searchDocApply");
    assert.equal(fs.existsSync(readSearchDocPath(repoRoot)), true);
  } finally {
    daemon.close();
  }
});

test("/step with a missing stepId returns 400", async () => {
  const repoRoot = makeServerRepoRoot();
  const daemon = await startTestDaemon(repoRoot);
  try {
    const r = await httpPostJson(daemon.port, "/step", { intent: "scan the repo" });
    assert.equal(r.status, 400);
    assert.equal((r.json as any).error, "missing stepId");
  } finally {
    daemon.close();
  }
});

// ─── Regression: payload_too_large and malformed JSON consistency (the fix) ─

test("(the fix) an oversized body returns 413 consistently across /run, /plan, and /step", async () => {
  const repoRoot = makeServerRepoRoot();
  const daemon = await startTestDaemon(repoRoot, { maxBodyBytes: 20 });
  try {
    const bigBody = JSON.stringify({ intent: "x".repeat(200) });
    for (const route of ["/run", "/plan", "/step"]) {
      const r = await httpRequest(daemon.port, "POST", route, {
        headers: { "content-type": "application/json" },
        body: bigBody,
      });
      assert.equal(r.status, 413, `${route} should return 413 for an oversized body`);
      assert.equal((r.json as any).error, "payload_too_large");
    }
  } finally {
    daemon.close();
  }
});

test("(the fix) malformed JSON returns 400 invalid_json, not a 500, consistently across /run, /plan, and /step", async () => {
  const repoRoot = makeServerRepoRoot();
  const daemon = await startTestDaemon(repoRoot);
  try {
    for (const route of ["/run", "/plan", "/step"]) {
      const r = await httpRequest(daemon.port, "POST", route, {
        headers: { "content-type": "application/json" },
        body: "{not valid json",
      });
      assert.equal(r.status, 400, `${route} should return 400 for malformed JSON`);
      assert.equal((r.json as any).error, "invalid_json");
    }
  } finally {
    daemon.close();
  }
});

// ─── Misc endpoints ──────────────────────────────────────────────────────────

test("/ui returns an HTML page", async () => {
  const repoRoot = makeServerRepoRoot();
  const daemon = await startTestDaemon(repoRoot);
  try {
    const r = await httpRequest(daemon.port, "GET", "/ui");
    assert.equal(r.status, 200);
    assert.match(r.bodyText, /<html/);
  } finally {
    daemon.close();
  }
});

test("/ (root) returns JSON when explicitly requested via ?format=json", async () => {
  const repoRoot = makeServerRepoRoot();
  const daemon = await startTestDaemon(repoRoot);
  try {
    const r = await httpRequest(daemon.port, "GET", "/?format=json");
    assert.equal(r.status, 200);
    assert.equal((r.json as any).service, "auernyx-mk2-daemon");
  } finally {
    daemon.close();
  }
});

test("/obsidian-judgment reflects the current judgment state", async () => {
  const repoRoot = makeServerRepoRoot();
  const daemon = await startTestDaemon(repoRoot); // fresh repo: judgment active
  try {
    const r = await httpRequest(daemon.port, "GET", "/obsidian-judgment");
    assert.equal(r.status, 200);
    assert.equal((r.json as any).active, true);
  } finally {
    daemon.close();
  }
});

test("an unknown route returns 404", async () => {
  const repoRoot = makeServerRepoRoot();
  const daemon = await startTestDaemon(repoRoot);
  try {
    const r = await httpRequest(daemon.port, "GET", "/definitely-not-a-route");
    assert.equal(r.status, 404);
  } finally {
    daemon.close();
  }
});
