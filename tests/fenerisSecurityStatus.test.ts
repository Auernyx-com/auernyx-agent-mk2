import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as net from "net";
import { fenerisSecurityStatus } from "../capabilities/fenerisSecurityStatus";
import { Ledger } from "../core/ledger";

// First test coverage for fenerisSecurityStatus.ts. This is Category 4 — the
// capability talks to a real host daemon over a hardcoded Unix domain socket
// path (/run/feneris/feneris.sock), which a test can neither reach nor safely
// create at the real location.
//
// Tried mocking net.createConnection directly first (node:test's t.mock)
// and hit a real environment wrinkle worth recording: under this project's
// tsx/ESM-interop compilation, `import * as net from "net"` yields
// `createConnection` as a non-configurable ACCESSOR property (a getter, no
// `.value`), not a plain writable data property — confirmed directly via
// Object.getOwnPropertyDescriptor. node:test's MockTracker.method requires a
// configurable data method and throws ERR_INVALID_ARG_VALUE on exactly this
// shape. So the capability itself needed one small, additive testability
// change: the hardcoded socket path is now read through socketPath(), which
// checks an AUERNYX_FENERIS_SOCKET_PATH env var first — the same override
// pattern core/daemonClient.ts and core/server.ts already use for
// AUERNYX_HOST/AUERNYX_PORT/AUERNYX_SECRET. Default behavior (no env var set)
// is unchanged. That lets these tests start a REAL Unix domain socket server
// under a tmp dir and run the genuine IPC exchange end to end, no stubbing.

function makeRepoRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mk2-feneris-status-test-"));
}

function ctx(repoRoot: string) {
  return { repoRoot, sessionId: "test-session", ledger: new Ledger(repoRoot) } as any;
}

function readLedgerEvents(repoRoot: string): Array<{ event: string; data: unknown }> {
  const p = path.join(repoRoot, "logs", "ledger.ndjson");
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .map((e) => ({ event: e.event, data: e.data }));
}

function useSocketPath(t: any, socketPath: string): void {
  const prev = process.env.AUERNYX_FENERIS_SOCKET_PATH;
  process.env.AUERNYX_FENERIS_SOCKET_PATH = socketPath;
  t.after(() => {
    if (prev === undefined) delete process.env.AUERNYX_FENERIS_SOCKET_PATH;
    else process.env.AUERNYX_FENERIS_SOCKET_PATH = prev;
  });
}

function startFakeFenerisServer(socketPath: string, respond: (req: any) => unknown): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => {
      let buf = "";
      socket.on("data", (chunk) => {
        buf += chunk.toString();
        const nl = buf.indexOf("\n");
        if (nl !== -1) {
          const line = buf.slice(0, nl);
          try {
            const req = JSON.parse(line);
            socket.write(JSON.stringify(respond(req)) + "\n");
          } catch {
            socket.end();
          }
        }
      });
    });
    server.on("error", reject);
    server.listen(socketPath, () => resolve(server));
  });
}

function startRawFenerisServer(socketPath: string, rawResponse: string): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => {
      socket.on("data", () => socket.write(rawResponse));
    });
    server.on("error", reject);
    server.listen(socketPath, () => resolve(server));
  });
}

function startSilentFenerisServer(socketPath: string): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    // Accepts the connection but never writes anything back — exercises the
    // 5s TIMEOUT_MS path in queryFenerisSocket.
    const server = net.createServer(() => {});
    server.on("error", reject);
    server.listen(socketPath, () => resolve(server));
  });
}

// ─── Happy path ─────────────────────────────────────────────────────────────

test("reports FAILED_CLOSED with honeypot/circuit-breaker guidance and formats the last event", async (t) => {
  const repoRoot = makeRepoRoot();
  const socketPath = path.join(repoRoot, "feneris.sock");
  const server = await startFakeFenerisServer(socketPath, () => ({
    system_state: "FAILED_CLOSED",
    last: { event_type: "honeypot_trip", ts: "2026-01-01T12:34:56.789Z" },
  }));
  t.after(() => server.close());
  useSocketPath(t, socketPath);

  const result = await fenerisSecurityStatus(ctx(repoRoot));
  assert.equal(result.system_state, "FAILED_CLOSED");
  assert.equal(result.last_event, "honeypot_trip");
  assert.equal(result.last_ts, "2026-01-01 12:34:56");
  assert.match(result.summary, /Honeypot or circuit breaker tripped/);
  assert.match(result.summary, /Last event: honeypot_trip at 2026-01-01 12:34:56/);
  assert.deepEqual(result.hil_gate, { status: "BYPASSED_POC", note: "LIVE_SYSTEM_WOULD_PAUSE_HERE: human approval required before reading security state" });
});

test("reports CONTROLLED as an anomaly contained, and falls back to last.event when event_type is absent", async (t) => {
  const repoRoot = makeRepoRoot();
  const socketPath = path.join(repoRoot, "feneris.sock");
  const server = await startFakeFenerisServer(socketPath, () => ({
    system_state: "CONTROLLED",
    last: { event: "rate_limit_triggered", ts: "2026-02-02T00:00:00Z" },
  }));
  t.after(() => server.close());
  useSocketPath(t, socketPath);

  const result = await fenerisSecurityStatus(ctx(repoRoot));
  assert.equal(result.system_state, "CONTROLLED");
  assert.equal(result.last_event, "rate_limit_triggered");
  assert.match(result.summary, /Anomaly detected and contained/);
});

test("reports any other state as nominal, with no last event when last is null", async (t) => {
  const repoRoot = makeRepoRoot();
  const socketPath = path.join(repoRoot, "feneris.sock");
  const server = await startFakeFenerisServer(socketPath, () => ({ system_state: "NOMINAL", last: null }));
  t.after(() => server.close());
  useSocketPath(t, socketPath);

  const result = await fenerisSecurityStatus(ctx(repoRoot));
  assert.equal(result.system_state, "NOMINAL");
  assert.equal(result.last_event, null);
  assert.equal(result.last_ts, null);
  assert.match(result.summary, /Network security nominal/);
  assert.ok(!result.summary.includes("Last event"));
});

test("defaults to UNKNOWN system_state and 'unknown' last_event when the daemon omits them", async (t) => {
  const repoRoot = makeRepoRoot();
  const socketPath = path.join(repoRoot, "feneris.sock");
  const server = await startFakeFenerisServer(socketPath, () => ({ last: {} }));
  t.after(() => server.close());
  useSocketPath(t, socketPath);

  const result = await fenerisSecurityStatus(ctx(repoRoot));
  assert.equal(result.system_state, "UNKNOWN");
  assert.equal(result.last_event, "unknown");
});

test("records start and complete ledger events on a successful query", async (t) => {
  const repoRoot = makeRepoRoot();
  const socketPath = path.join(repoRoot, "feneris.sock");
  const server = await startFakeFenerisServer(socketPath, () => ({ system_state: "NOMINAL", last: null }));
  t.after(() => server.close());
  useSocketPath(t, socketPath);

  await fenerisSecurityStatus(ctx(repoRoot));
  const events = readLedgerEvents(repoRoot).map((e) => e.event);
  assert.deepEqual(events, ["feneris.security.status.start", "feneris.security.status.complete"]);
});

// ─── Error paths ────────────────────────────────────────────────────────────

test("a connection refused/missing socket is reported as 'Socket unreachable', not a permission error, and logs an error event", async (t) => {
  const repoRoot = makeRepoRoot();
  const missingSocketPath = path.join(repoRoot, "does-not-exist.sock");
  useSocketPath(t, missingSocketPath);

  const result = await fenerisSecurityStatus(ctx(repoRoot));
  assert.equal(result.system_state, "CONTROLLED");
  assert.match(result.summary, /Socket unreachable/);
  assert.ok(!result.summary.includes("groupadd"));

  const events = readLedgerEvents(repoRoot);
  const errorEvent = events.find((e) => e.event === "feneris.security.status.error");
  assert.ok(errorEvent);
  assert.equal((errorEvent!.data as any).permission_denied, false);
});

test("an EACCES/EPERM socket error gives the specific groupadd remediation summary and logs permission_denied:true", async (t) => {
  const repoRoot = makeRepoRoot();
  // A real, deterministic way to get a genuine EACCES from the kernel without
  // root: create the socket file, then strip all permissions from it before
  // connecting. connect() on a mode-000 socket fails with EACCES.
  const socketPath = path.join(repoRoot, "feneris.sock");
  const server = await startFakeFenerisServer(socketPath, () => ({ system_state: "NOMINAL", last: null }));
  t.after(() => server.close());
  fs.chmodSync(socketPath, 0o000);
  useSocketPath(t, socketPath);

  const result = await fenerisSecurityStatus(ctx(repoRoot));
  assert.equal(result.system_state, "CONTROLLED");
  assert.match(result.summary, /Socket permission denied/);
  assert.match(result.summary, /groupadd feneris/);

  const events = readLedgerEvents(repoRoot);
  const errorEvent = events.find((e) => e.event === "feneris.security.status.error");
  assert.equal((errorEvent!.data as any).permission_denied, true);
});

test("a malformed (non-JSON) daemon response is reported as 'Socket unreachable'", async (t) => {
  const repoRoot = makeRepoRoot();
  const socketPath = path.join(repoRoot, "feneris.sock");
  const server = await startRawFenerisServer(socketPath, "not json at all\n");
  t.after(() => server.close());
  useSocketPath(t, socketPath);

  const result = await fenerisSecurityStatus(ctx(repoRoot));
  assert.match(result.summary, /Socket unreachable/);
  assert.match(result.summary, /malformed response/);
});

test("a daemon that never responds times out and is reported as unreachable (TIMEOUT_MS)", async (t) => {
  const repoRoot = makeRepoRoot();
  const socketPath = path.join(repoRoot, "feneris.sock");
  const server = await startSilentFenerisServer(socketPath);
  t.after(() => server.close());
  useSocketPath(t, socketPath);

  const result = await fenerisSecurityStatus(ctx(repoRoot));
  assert.match(result.summary, /Socket unreachable/);
  assert.match(result.summary, /timeout/i);
});
