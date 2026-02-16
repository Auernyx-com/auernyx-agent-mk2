import assert from "node:assert/strict";
import test from "node:test";
import { analyzeDependency } from "../capabilities/analyzeDependency";
import type { RouterContext } from "../core/router";

function createMockRouterContext(): RouterContext {
  // Provide a minimal but realistic mock implementation of RouterContext.
  // Adjust properties here as RouterContext evolves to keep tests representative.
  return {
    // Common router context fields; unused ones will simply be ignored.
    params: {},
    query: {},
    state: {},
    request: {
      method: "GET",
      url: "https://example.com",
      headers: new Headers(),
      body: null
    },
    response: {
      status: 200,
      headers: new Headers(),
      body: undefined
    },
    log: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {}
    }
  } as unknown as RouterContext;
}

const mockContext = createMockRouterContext();

type MockResponse = { ok: boolean; status: number; body: unknown };

function mockFetchSequence(sequence: MockResponse[]) {
  let index = 0;
  const original = globalThis.fetch;

  globalThis.fetch = (async () => {
    const current = sequence[index++];
    if (!current) throw new Error("Unexpected fetch call");

    return {
      ok: current.ok,
      status: current.status,
      async json() {
        return current.body;
      }
    } as Response;
  }) as typeof fetch;

  return () => {
    globalThis.fetch = original;
  };
}

test("patch update with no breaking changes is low risk", async () => {
  const restore = mockFetchSequence([
    {
      ok: true,
      status: 200,
      body: {
        time: { "1.0.1": "2023-01-01T00:00:00.000Z" },
        versions: { "1.0.1": { description: "small fix" } }
      }
    },
    { ok: true, status: 200, body: { pkgpatch: [] } },
    { ok: true, status: 200, body: { pkgpatch: [] } }
  ]);

  const result = await analyzeDependency(mockContext, {
    packageName: "pkgpatch",
    oldVersion: "1.0.0",
    newVersion: "1.0.1"
  });
  restore();

  assert.equal(result.ok, true);
  assert.equal(result.versionJump, "patch");
  assert.equal(result.riskLevel, "low");
  assert.equal(result.recommendation, "approve");
});

test("minor update with no breaking changes is medium risk", async () => {
  const restore = mockFetchSequence([
    {
      ok: true,
      status: 200,
      body: {
        time: { "1.1.0": "2023-01-01T00:00:00.000Z" },
        versions: { "1.1.0": { description: "new feature" } }
      }
    },
    { ok: true, status: 200, body: { pkgminor: [] } },
    { ok: true, status: 200, body: { pkgminor: [] } }
  ]);

  const result = await analyzeDependency(mockContext, {
    packageName: "pkgminor",
    oldVersion: "1.0.0",
    newVersion: "1.1.0"
  });
  restore();

  assert.equal(result.ok, true);
  assert.equal(result.versionJump, "minor");
  assert.equal(result.riskLevel, "medium");
  assert.equal(result.recommendation, "review");
});

test("major update is high risk", async () => {
  const restore = mockFetchSequence([
    {
      ok: true,
      status: 200,
      body: {
        time: { "2.0.0": "2023-01-01T00:00:00.000Z" },
        versions: { "2.0.0": { description: "stable" } }
      }
    },
    { ok: true, status: 200, body: { pkgmajor: [] } },
    { ok: true, status: 200, body: { pkgmajor: [] } }
  ]);

  const result = await analyzeDependency(mockContext, {
    packageName: "pkgmajor",
    oldVersion: "1.2.0",
    newVersion: "2.0.0"
  });
  restore();

  assert.equal(result.ok, true);
  assert.equal(result.versionJump, "major");
  assert.equal(result.riskLevel, "high");
  assert.equal(result.recommendation, "review");
});

test("security fixes in patch stay low risk", async () => {
  const restore = mockFetchSequence([
    {
      ok: true,
      status: 200,
      body: {
        time: { "1.0.1": "2023-01-01T00:00:00.000Z" },
        versions: { "1.0.1": { description: "security cleanup" } }
      }
    },
    {
      ok: true,
      status: 200,
      body: {
        pkgfix: [{ id: "100", severity: "high", title: "old vuln", url: "https://example/advisory/100" }]
      }
    },
    { ok: true, status: 200, body: { pkgfix: [] } }
  ]);

  const result = await analyzeDependency(mockContext, {
    packageName: "pkgfix",
    oldVersion: "1.0.0",
    newVersion: "1.0.1"
  });
  restore();

  assert.equal(result.ok, true);
  assert.equal(result.securityImpact, "fixes");
  assert.equal(result.riskLevel, "low");
  assert.equal(result.recommendation, "approve");
});

test("new vulnerabilities produce critical risk", async () => {
  const restore = mockFetchSequence([
    {
      ok: true,
      status: 200,
      body: {
        time: { "1.0.1": "2023-01-01T00:00:00.000Z" },
        versions: { "1.0.1": { description: "new patch" } }
      }
    },
    { ok: true, status: 200, body: { pkgvuln: [] } },
    {
      ok: true,
      status: 200,
      body: {
        pkgvuln: [{ id: "200", severity: "critical", title: "new vuln", url: "https://example/advisory/200" }]
      }
    }
  ]);

  const result = await analyzeDependency(mockContext, {
    packageName: "pkgvuln",
    oldVersion: "1.0.0",
    newVersion: "1.0.1"
  });
  restore();

  assert.equal(result.ok, true);
  assert.equal(result.securityImpact, "introduces");
  assert.equal(result.riskLevel, "critical");
  assert.equal(result.recommendation, "reject");
});

test("network failure fail-closes", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("offline");
  }) as typeof fetch;

  const result = await analyzeDependency(mockContext, {
    packageName: "pkgoffline",
    oldVersion: "1.0.0",
    newVersion: "1.0.1"
  });

  globalThis.fetch = original;
  assert.equal(result.ok, false);
  assert.equal(result.riskLevel, "critical");
  assert.equal(result.recommendation, "reject");
});

test("malformed input fail-closes", async () => {
  const result = await analyzeDependency(mockContext, {
    packageName: "badinput",
    oldVersion: "bad",
    newVersion: "1.0.0"
  });

  assert.equal(result.ok, false);
  assert.equal(result.riskLevel, "critical");
  assert.equal(result.recommendation, "reject");
});

test("unknown package fail-closes", async () => {
  const restore = mockFetchSequence([{ ok: false, status: 404, body: {} }]);

  const result = await analyzeDependency(mockContext, {
    packageName: "this-package-does-not-exist-test-case",
    oldVersion: "1.0.0",
    newVersion: "1.0.1"
  });
  restore();

  assert.equal(result.ok, false);
  assert.equal(result.recommendation, "reject");
});

test("analysisHash is deterministic for identical input and data", async () => {
  const firstRestore = mockFetchSequence([
    {
      ok: true,
      status: 200,
      body: {
        time: { "1.0.1": "2023-01-01T00:00:00.000Z" },
        versions: { "1.0.1": { description: "stable patch" } }
      }
    },
    { ok: true, status: 200, body: { pkghash: [] } },
    { ok: true, status: 200, body: { pkghash: [] } }
  ]);

  const first = await analyzeDependency(mockContext, {
    packageName: "pkghash",
    oldVersion: "1.0.0",
    newVersion: "1.0.1"
  });
  firstRestore();

  const secondRestore = mockFetchSequence([
    {
      ok: true,
      status: 200,
      body: {
        time: { "1.0.1": "2023-01-01T00:00:00.000Z" },
        versions: { "1.0.1": { description: "stable patch" } }
      }
    },
    { ok: true, status: 200, body: { pkghash: [] } },
    { ok: true, status: 200, body: { pkghash: [] } }
  ]);

  const second = await analyzeDependency(mockContext, {
    packageName: "pkghash",
    oldVersion: "1.0.0",
    newVersion: "1.0.1"
  });
  secondRestore();

  assert.equal(first.analysisHash, second.analysisHash);
});
