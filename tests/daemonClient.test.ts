import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "fs";
import * as path from "path";
import { getDaemonAddress, isDaemonHealthy, tryRunViaDaemon } from "../core/daemonClient";
import { makeServerRepoRoot, makeGitRepoRoot, startTestDaemon, validApproval } from "./helpers/testDaemon";

// First test coverage for core/daemonClient.ts. Found and fixed the single
// most severe bug of this whole test-coverage pass: the governed
// /plan -> /step orchestrator loop always targeted plan.steps[0]'s id, no
// matter what. For a single-step capability (28 of the 29 shipped ones) that
// happens to be harmless — there's only one step to target. But for
// searchDocApply — the system's one real 2-step plan (step-1
// preview/READ_ONLY, step-2 apply/CONTROLLED_WRITE), and the exact flow
// clients/cli/auernyx.ts drives (call once with no approval to get the plan,
// prompt a human, retry with a fully apply-ready approval) — the retry call
// still only ever re-ran step-1's preview. Verified directly end to end
// against a real daemon, replaying the CLI's exact two-call sequence: the
// "approve and apply" call came back ok:true, capability:"searchDocPreview",
// and the file was never written. No error, no refusal — a human approving
// "apply this" would see success while nothing happened. Fixed by driving
// every step of the plan to completion with the one approval given, stopping
// immediately if any step legitimately refuses.

process.setMaxListeners(200);

// ─── getDaemonAddress ───────────────────────────────────────────────────────

test("getDaemonAddress returns the configured default when nothing is overridden", () => {
  const repoRoot = makeServerRepoRoot();
  const addr = getDaemonAddress(repoRoot);
  assert.equal(addr.host, "127.0.0.1");
  assert.equal(addr.port, 43117);
});

test("getDaemonAddress respects AUERNYX_HOST and AUERNYX_PORT env overrides", () => {
  const repoRoot = makeServerRepoRoot();
  const savedHost = process.env.AUERNYX_HOST;
  const savedPort = process.env.AUERNYX_PORT;
  try {
    process.env.AUERNYX_HOST = "0.0.0.0";
    process.env.AUERNYX_PORT = "9999";
    const addr = getDaemonAddress(repoRoot);
    assert.equal(addr.host, "0.0.0.0");
    assert.equal(addr.port, 9999);
  } finally {
    if (savedHost === undefined) delete process.env.AUERNYX_HOST;
    else process.env.AUERNYX_HOST = savedHost;
    if (savedPort === undefined) delete process.env.AUERNYX_PORT;
    else process.env.AUERNYX_PORT = savedPort;
  }
});

test("getDaemonAddress falls back to the config default when AUERNYX_PORT is not a valid positive number", () => {
  const repoRoot = makeServerRepoRoot();
  const saved = process.env.AUERNYX_PORT;
  try {
    process.env.AUERNYX_PORT = "not-a-number";
    const addr = getDaemonAddress(repoRoot);
    assert.equal(addr.port, 43117);
  } finally {
    if (saved === undefined) delete process.env.AUERNYX_PORT;
    else process.env.AUERNYX_PORT = saved;
  }
});

// ─── isDaemonHealthy ────────────────────────────────────────────────────────

test("isDaemonHealthy returns false when nothing is listening", async () => {
  const repoRoot = makeServerRepoRoot();
  const saved = process.env.AUERNYX_PORT;
  try {
    process.env.AUERNYX_PORT = "1"; // reserved, nothing listens here
    const healthy = await isDaemonHealthy({ repoRoot, timeoutMs: 300 });
    assert.equal(healthy, false);
  } finally {
    if (saved === undefined) delete process.env.AUERNYX_PORT;
    else process.env.AUERNYX_PORT = saved;
  }
});

test("isDaemonHealthy returns true against a real, healthy daemon", async () => {
  const repoRoot = makeServerRepoRoot();
  const daemon = await startTestDaemon(repoRoot, { writeEnabled: true });
  const saved = process.env.AUERNYX_PORT;
  try {
    process.env.AUERNYX_PORT = String(daemon.port);
    const healthy = await isDaemonHealthy({ repoRoot });
    assert.equal(healthy, true);
  } finally {
    if (saved === undefined) delete process.env.AUERNYX_PORT;
    else process.env.AUERNYX_PORT = saved;
    daemon.close();
  }
});

test("isDaemonHealthy returns false against a real but unhealthy (judgment-active) daemon", async () => {
  const repoRoot = makeServerRepoRoot();
  const daemon = await startTestDaemon(repoRoot); // fresh repo, judgment active -> /health 503
  const saved = process.env.AUERNYX_PORT;
  try {
    process.env.AUERNYX_PORT = String(daemon.port);
    const healthy = await isDaemonHealthy({ repoRoot });
    assert.equal(healthy, false);
  } finally {
    if (saved === undefined) delete process.env.AUERNYX_PORT;
    else process.env.AUERNYX_PORT = saved;
    daemon.close();
  }
});

// ─── tryRunViaDaemon: meta intents and no-daemon ───────────────────────────

async function withDaemonPort<T>(port: number, fn: () => Promise<T>): Promise<T> {
  const saved = process.env.AUERNYX_PORT;
  process.env.AUERNYX_PORT = String(port);
  try {
    return await fn();
  } finally {
    if (saved === undefined) delete process.env.AUERNYX_PORT;
    else process.env.AUERNYX_PORT = saved;
  }
}

test("tryRunViaDaemon returns null when no daemon is reachable, rather than throwing", async () => {
  const repoRoot = makeServerRepoRoot();
  const result = await withDaemonPort(1, () => tryRunViaDaemon({ repoRoot, timeoutMs: 300 }, "ping"));
  assert.equal(result, null);
});

test("tryRunViaDaemon handles the 'ping' meta intent via /run", async () => {
  const repoRoot = makeServerRepoRoot();
  const daemon = await startTestDaemon(repoRoot);
  try {
    const result = await withDaemonPort(daemon.port, () => tryRunViaDaemon({ repoRoot }, "ping"));
    assert.deepEqual(result, { ok: true, capability: undefined, result: { pong: true }, error: undefined });
  } finally {
    daemon.close();
  }
});

// ─── tryRunViaDaemon: single-step governed flow (the common case) ─────────

test("tryRunViaDaemon returns step_approval_required with the plan when no approval is given", async () => {
  const repoRoot = makeServerRepoRoot(["scanRepo"]);
  const daemon = await startTestDaemon(repoRoot, { writeEnabled: true });
  try {
    const result = await withDaemonPort(daemon.port, () => tryRunViaDaemon({ repoRoot }, "scan the repo"));
    assert.equal(result!.ok, false);
    assert.equal(result!.error, "step_approval_required");
    assert.equal((result as any).result.plan.steps[0].tool.name, "scanRepo");
  } finally {
    daemon.close();
  }
});

test("tryRunViaDaemon executes a real single-step capability end to end once approved", async () => {
  const repoRoot = makeServerRepoRoot(["scanRepo"]);
  const daemon = await startTestDaemon(repoRoot, { writeEnabled: true });
  try {
    const result = await withDaemonPort(daemon.port, () =>
      tryRunViaDaemon({ repoRoot }, "scan the repo", undefined, validApproval)
    );
    assert.equal(result!.ok, true);
    assert.equal(result!.capability, "scanRepo");
    assert.equal((result as any).result.outputs[0].tool.name, "scanRepo");
  } finally {
    daemon.close();
  }
});

// ─── tryRunViaDaemon: the multi-step regression (the fix) ──────────────────

test("(the fix) tryRunViaDaemon drives the real 2-step searchDoc plan all the way to the actual write, not just step-1's preview", async () => {
  const repoRoot = makeGitRepoRoot(["searchDocPreview", "searchDocApply"]);
  const daemon = await startTestDaemon(repoRoot, { writeEnabled: true });
  try {
    const first = await withDaemonPort(daemon.port, () =>
      tryRunViaDaemon({ repoRoot }, "search doc apply x", { action: "add", docPath: "docs/a.md" })
    );
    assert.equal(first!.ok, false);
    assert.equal(first!.error, "step_approval_required");
    const rollbackPointIds = ((first as any).result.plan.rollbackPoints as any[]).map((rp) => rp.id);

    const approval = {
      ...validApproval,
      identity: "Test Approver",
      apply: true,
      confirm: "APPLY",
      acknowledgedRollbackPointIds: rollbackPointIds,
    };

    const second = await withDaemonPort(daemon.port, () =>
      tryRunViaDaemon({ repoRoot }, "search doc apply x", { action: "add", docPath: "docs/a.md" }, approval)
    );

    assert.equal(second!.ok, true);
    assert.equal(second!.capability, "searchDocApply", "must report the step that actually ran (the write), not step-1's preview");
    assert.equal(fs.existsSync(path.join(repoRoot, "docs", "SEARCH.md")), true, "the file must actually have been written");
    assert.equal(fs.readFileSync(path.join(repoRoot, "docs", "SEARCH.md"), "utf8"), "# Search Index\n\n- docs/a.md\n");
  } finally {
    daemon.close();
  }
});

test("(the fix) a single-step plan is unaffected by the multi-step loop change — one /step call, same as before", async () => {
  const repoRoot = makeServerRepoRoot(["scanRepo"]);
  const daemon = await startTestDaemon(repoRoot, { writeEnabled: true });
  try {
    const result = await withDaemonPort(daemon.port, () =>
      tryRunViaDaemon({ repoRoot }, "scan the repo", undefined, validApproval)
    );
    assert.equal(result!.ok, true);
    assert.equal((result as any).result.outputs.length, 1);
  } finally {
    daemon.close();
  }
});

test("tryRunViaDaemon stops and reports failure immediately if a later step in the plan is refused", async () => {
  const repoRoot = makeGitRepoRoot(["searchDocPreview", "searchDocApply"]);
  const daemon = await startTestDaemon(repoRoot, { writeEnabled: true });
  try {
    // A fully "apply" approval but missing the required rollback acknowledgment
    // for step-2 — step-1 succeeds, step-2 must be refused, and the loop must
    // not silently report overall success.
    const approval = { ...validApproval, identity: "Test Approver", apply: true, confirm: "APPLY" };
    const result = await withDaemonPort(daemon.port, () =>
      tryRunViaDaemon({ repoRoot }, "search doc apply x", { action: "add", docPath: "docs/a.md" }, approval)
    );
    assert.equal(result!.ok, false);
    assert.equal(fs.existsSync(path.join(repoRoot, "docs", "SEARCH.md")), false);
  } finally {
    daemon.close();
  }
});
