import assert from "node:assert/strict";
import test from "node:test";
import { kennrDesignExtract } from "../capabilities/kennrDesignExtract";
import { kennrDesignDnaSynthesize } from "../capabilities/kennrDesignDnaSynthesize";
import { kennrDesignDiff } from "../capabilities/kennrDesignDiff";
import { skadiLeadScan } from "../capabilities/skadiLeadScan";
import { mockFetchSequence, mockFetchNetworkFailure } from "./helpers/mockFetch";

// First test coverage for the 4 capabilities that call an external Cloudflare
// Worker directly via global fetch: Kennr's 3 (extract, DNA synthesize,
// diff) and Skadi's 1 (lead scan). All 4 share the same shape (validate
// input -> fetch -> handle non-ok -> handle exception -> success), all 4
// self-report hil_gate: BYPASSED_POC (documented, honest, not something to
// "fix" — see memory).

const ctx = { repoRoot: "/fake", sessionId: "test-session" } as any;

test("kennrDesignExtract refuses locally (no fetch call) when neither url nor html is given", async () => {
  const mock = mockFetchSequence([]);
  try {
    const result = await kennrDesignExtract(ctx, {});
    assert.equal(result.approved, false);
    assert.ok(result.reasoning.startsWith("REFUSED"));
    assert.equal(mock.calls.length, 0);
  } finally {
    mock.restore();
  }
});

test("kennrDesignExtract succeeds end to end against a mocked Worker response", async () => {
  const mock = mockFetchSequence([{ ok: true, status: 200, body: { colors: ["#fff"], fonts: ["Inter"] } }]);
  try {
    const result = await kennrDesignExtract(ctx, { url: "https://example.com", label: "test" });
    assert.equal(result.approved, true);
    assert.deepEqual(result.extraction, { colors: ["#fff"], fonts: ["Inter"] });
    assert.equal(result.hil_gate.status, "BYPASSED_POC");
    assert.ok(mock.calls[0].url.endsWith("/api/extract/url"));
  } finally {
    mock.restore();
  }
});

test("kennrDesignExtract reports failure cleanly (not a thrown exception) on a non-ok Worker response", async () => {
  const mock = mockFetchSequence([{ ok: false, status: 500, body: {}, text: "internal error" }]);
  try {
    const result = await kennrDesignExtract(ctx, { html: "<html></html>" });
    assert.equal(result.approved, false);
    assert.ok(result.reasoning.includes("500"));
  } finally {
    mock.restore();
  }
});

test("kennrDesignExtract reports failure cleanly on a network-level failure", async () => {
  const mock = mockFetchNetworkFailure();
  try {
    const result = await kennrDesignExtract(ctx, { url: "https://example.com" });
    assert.equal(result.approved, false);
    assert.ok(result.reasoning.includes("network unreachable"));
  } finally {
    mock.restore();
  }
});

test("kennrDesignDnaSynthesize refuses locally when extraction_ids is missing or empty", async () => {
  const mock = mockFetchSequence([]);
  try {
    const a = await kennrDesignDnaSynthesize(ctx, {});
    assert.equal(a.approved, false);
    const b = await kennrDesignDnaSynthesize(ctx, { extraction_ids: [] });
    assert.equal(b.approved, false);
    assert.equal(mock.calls.length, 0);
  } finally {
    mock.restore();
  }
});

test("kennrDesignDnaSynthesize succeeds end to end against a mocked Worker response", async () => {
  const mock = mockFetchSequence([{ ok: true, status: 200, body: { dna_id: "dna-1" } }]);
  try {
    const result = await kennrDesignDnaSynthesize(ctx, { extraction_ids: ["e1", "e2"], project_name: "Test" });
    assert.equal(result.approved, true);
    assert.deepEqual(result.dna, { dna_id: "dna-1" });
    assert.ok(mock.calls[0].url.endsWith("/api/analyze/dna"));
  } finally {
    mock.restore();
  }
});

test("kennrDesignDiff refuses locally when either dna id is missing", async () => {
  const mock = mockFetchSequence([]);
  try {
    const result = await kennrDesignDiff(ctx, { dna_a_id: "a" });
    assert.equal(result.approved, false);
    assert.equal(mock.calls.length, 0);
  } finally {
    mock.restore();
  }
});

test("kennrDesignDiff succeeds end to end against a mocked Worker response", async () => {
  const mock = mockFetchSequence([{ ok: true, status: 200, body: { changed: ["color"] } }]);
  try {
    const result = await kennrDesignDiff(ctx, { dna_a_id: "a", dna_b_id: "b" });
    assert.equal(result.approved, true);
    assert.deepEqual(result.diff, { changed: ["color"] });
    assert.ok(mock.calls[0].url.endsWith("/api/dna/diff"));
  } finally {
    mock.restore();
  }
});

test("skadiLeadScan uses the day-of-week rotation when no market index is given", async () => {
  const mock = mockFetchSequence([{ ok: true, status: 200, body: { leads: [] } }]);
  try {
    const result = await skadiLeadScan(ctx, {});
    assert.equal(result.approved, true);
    assert.ok(typeof result.market === "string" && result.market.length > 0);
  } finally {
    mock.restore();
  }
});

test("skadiLeadScan clamps an out-of-range market index into the valid 0-6 range", async () => {
  const mockHigh = mockFetchSequence([{ ok: true, status: 200, body: { leads: [] } }]);
  try {
    const result = await skadiLeadScan(ctx, { market: 999 });
    assert.equal(result.market, "Palisade"); // index 6, the last market
  } finally {
    mockHigh.restore();
  }

  const mockLow = mockFetchSequence([{ ok: true, status: 200, body: { leads: [] } }]);
  try {
    const result = await skadiLeadScan(ctx, { market: -50 });
    assert.equal(result.market, "Grand Junction"); // index 0, the first market
  } finally {
    mockLow.restore();
  }
});

test("skadiLeadScan reports failure cleanly on a non-ok Worker response", async () => {
  const mock = mockFetchSequence([{ ok: false, status: 503, body: {}, text: "unavailable" }]);
  try {
    const result = await skadiLeadScan(ctx, { market: 0 });
    assert.equal(result.approved, false);
    assert.equal(result.market, "Grand Junction");
    assert.ok(result.reasoning.includes("503"));
  } finally {
    mock.restore();
  }
});
