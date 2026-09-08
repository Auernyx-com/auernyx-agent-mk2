import assert from "node:assert/strict";
import test from "node:test";
import { assertSafeToBind, startDaemon } from "../core/server";
import { makeGitRepoRoot } from "./helpers/testDaemon";

// Independent-audit finding (2026-09-08, round 10, medium): requireSecretIfConfigured()
// fails OPEN when no secret is configured -- every route on the daemon,
// including controlled operations gated behind an Approval object, is
// reachable with zero authentication. Reasonable for the actual default
// (host 127.0.0.1), but nothing previously stopped an operator from setting
// AUERNYX_HOST to a non-loopback address without also setting
// AUERNYX_SECRET -- silently combining "reachable from anywhere" with
// "requires nothing to control it." Fixed with a synchronous, fail-closed
// check at daemon startup, before the HTTP listener ever binds.

test("throws for a non-loopback host with no secret configured", () => {
  assert.throws(() => assertSafeToBind("0.0.0.0", false), /refusing to start/);
});

test("does not throw for a non-loopback host when a secret IS configured", () => {
  assert.doesNotThrow(() => assertSafeToBind("0.0.0.0", true));
});

test("does not throw for loopback hosts even with no secret configured", () => {
  for (const host of ["127.0.0.1", "::1", "localhost"]) {
    assert.doesNotThrow(() => assertSafeToBind(host, false));
  }
});

test("does not throw for an arbitrary LAN address when a secret IS configured", () => {
  assert.doesNotThrow(() => assertSafeToBind("192.168.1.50", true));
});

// End-to-end: startDaemon() itself must refuse before ever calling
// server.listen() -- confirmed here by observing the synchronous throw
// (a real listening server bound to a non-loopback address is never
// created by this test, since the function throws before reaching that
// point).
test("startDaemon refuses to start on a non-loopback host with no secret", () => {
  const repoRoot = makeGitRepoRoot();
  const saved = { host: process.env.AUERNYX_HOST, secret: process.env.AUERNYX_SECRET, port: process.env.AUERNYX_PORT };
  process.env.AUERNYX_HOST = "0.0.0.0";
  process.env.AUERNYX_PORT = "0";
  delete process.env.AUERNYX_SECRET;
  try {
    assert.throws(() => startDaemon(repoRoot), /refusing to start/);
  } finally {
    if (saved.host === undefined) delete process.env.AUERNYX_HOST; else process.env.AUERNYX_HOST = saved.host;
    if (saved.secret === undefined) delete process.env.AUERNYX_SECRET; else process.env.AUERNYX_SECRET = saved.secret;
    if (saved.port === undefined) delete process.env.AUERNYX_PORT; else process.env.AUERNYX_PORT = saved.port;
  }
});
