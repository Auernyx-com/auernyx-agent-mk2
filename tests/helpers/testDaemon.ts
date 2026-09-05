// Shared helper for spinning up a real core/server.ts daemon against a real
// (ephemeral-port) HTTP listener, for genuine end-to-end request/response
// testing rather than unit-testing route handlers in isolation.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as http from "http";
import { execFileSync } from "child_process";
import { startDaemon } from "../../core/server";

export function makeServerRepoRoot(allowedCapabilities: string[] = ["scanRepo", "memoryCheck"]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mk2-server-test-"));
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "test" }));
  fs.mkdirSync(path.join(dir, "config"), { recursive: true });
  fs.writeFileSync(path.join(dir, "config", "allowlist.json"), JSON.stringify({ allowedCapabilities }));
  return dir;
}

// A real, clean git repo — runLifecycle's own APPLY preconditions (preflight
// git status capture/dirty check) require one for any mutating step, same
// as tests/runLifecycle.armedCheck.test.ts. .gitignore matches this repo's
// own, so runLifecycle's own bookkeeping (.auernyx/, logs/) doesn't make the
// tree look dirty mid-run.
export function makeGitRepoRoot(allowedCapabilities: string[] = ["scanRepo", "memoryCheck"]): string {
  const dir = makeServerRepoRoot(allowedCapabilities);
  // Non-readonly capabilities require a configured approverIdentity matching
  // the approval's own identity field (fail-closed by default otherwise).
  fs.writeFileSync(
    path.join(dir, "config", "auernyx.config.json"),
    JSON.stringify({ governance: { approverIdentity: "Test Approver" } })
  );
  fs.writeFileSync(path.join(dir, ".gitignore"), ".canon/\nvar/canon/\n.auernyx/\nlogs/\n");
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", "initial"], { cwd: dir });
  return dir;
}

export interface TestDaemonOptions {
  secret?: string;
  maxBodyBytes?: number;
  rateWindowMs?: number;
  rateMax?: number;
  writeEnabled?: boolean; // seal genesis on this boot when true
}

export interface TestDaemon {
  server: http.Server;
  port: number;
  close: () => void;
}

const ENV_KEYS = [
  "AUERNYX_HOST",
  "AUERNYX_PORT",
  "AUERNYX_SECRET",
  "AUERNYX_MAX_BODY_BYTES",
  "AUERNYX_RATE_WINDOW_MS",
  "AUERNYX_RATE_MAX",
  "AUERNYX_WRITE_ENABLED",
] as const;

// startDaemon reads these env vars synchronously, at call time, into
// per-instance closure variables — so it's safe to set them immediately
// before calling startDaemon() and restore the previous values right after,
// with no risk of leaking into other tests.
export async function startTestDaemon(repoRoot: string, opts: TestDaemonOptions = {}): Promise<TestDaemon> {
  const saved: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) saved[k] = process.env[k];

  process.env.AUERNYX_HOST = "127.0.0.1";
  process.env.AUERNYX_PORT = "0"; // let the OS assign a free port
  if (opts.secret !== undefined) process.env.AUERNYX_SECRET = opts.secret;
  else delete process.env.AUERNYX_SECRET;
  if (opts.maxBodyBytes !== undefined) process.env.AUERNYX_MAX_BODY_BYTES = String(opts.maxBodyBytes);
  else delete process.env.AUERNYX_MAX_BODY_BYTES;
  if (opts.rateWindowMs !== undefined) process.env.AUERNYX_RATE_WINDOW_MS = String(opts.rateWindowMs);
  else delete process.env.AUERNYX_RATE_WINDOW_MS;
  if (opts.rateMax !== undefined) process.env.AUERNYX_RATE_MAX = String(opts.rateMax);
  else delete process.env.AUERNYX_RATE_MAX;
  process.env.AUERNYX_WRITE_ENABLED = opts.writeEnabled ? "1" : "0";

  const server = startDaemon(repoRoot);

  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }

  await new Promise<void>((resolve) => server.once("listening", resolve));
  const port = (server.address() as { port: number }).port;

  return {
    server,
    port,
    close: () => server.close(),
  };
}

export interface HttpResult {
  status: number;
  headers: http.IncomingHttpHeaders;
  bodyText: string;
  json: unknown;
}

export function httpRequest(
  port: number,
  method: string,
  urlPath: string,
  options: { headers?: Record<string, string>; body?: string } = {}
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const r = http.request(
      { host: "127.0.0.1", port, path: urlPath, method, headers: options.headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const bodyText = Buffer.concat(chunks).toString("utf8");
          let json: unknown = undefined;
          try {
            json = JSON.parse(bodyText);
          } catch {
            // not JSON — leave undefined, callers that expect JSON will notice
          }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, bodyText, json });
        });
      }
    );
    r.on("error", reject);
    if (options.body !== undefined) r.write(options.body);
    r.end();
  });
}

export function httpPostJson(
  port: number,
  urlPath: string,
  body: unknown,
  headers?: Record<string, string>
): Promise<HttpResult> {
  return httpRequest(port, "POST", urlPath, {
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

export const validApproval = {
  approvedBy: "human" as const,
  at: new Date().toISOString(),
  reason: "test",
};
