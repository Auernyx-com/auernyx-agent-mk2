import assert from "node:assert/strict";
import test from "node:test";
import { wyerdTraderTradingCycle } from "../capabilities/wyerdTraderTradingCycle";

// First test coverage for wyerdTraderTradingCycle — pure decision logic,
// no network calls (it takes the 3 model verdicts as input, doesn't fetch
// them itself). Found and fixed a real gap while writing these: the
// original input validation only checked verdicts.length === 3, not that
// the 3 seats were actually AUENRIX/GHOST/BASTION — 3 verdicts missing
// BASTION entirely got approved outright, silently skipping BASTION's
// veto and confidence-floor checks (documented as "a hard stop" and
// "binding, not advisory"). Verified directly before fixing.

const ctx = { repoRoot: "/fake", sessionId: "test-session" } as any;

function verdict(seat: "AUENRIX" | "GHOST" | "BASTION", overrides: Partial<Record<string, unknown>> = {}) {
  return {
    seat,
    provider: "test",
    model: "test-model",
    verdict: "BUY",
    asset: "DOGE",
    confidence: 90,
    veto: false,
    reasoning: "test reasoning",
    ...overrides,
  };
}

function cycleInput(verdicts: unknown[]) {
  return {
    cycle_id: "c1",
    timestamp: new Date().toISOString(),
    prices: { DOGE: 0.1, AVAX: 20 },
    verdicts,
  };
}

test("refuses when input isn't exactly 3 verdicts", async () => {
  const a = await wyerdTraderTradingCycle(ctx, {});
  assert.equal(a.approved, false);
  const b = await wyerdTraderTradingCycle(ctx, cycleInput([verdict("AUENRIX"), verdict("GHOST")]));
  assert.equal(b.approved, false);
});

test("refuses when the 3 verdicts don't include exactly one BASTION, AUENRIX, and GHOST each (the fix)", async () => {
  const missingBastion = await wyerdTraderTradingCycle(
    ctx,
    cycleInput([verdict("AUENRIX"), verdict("AUENRIX"), verdict("GHOST")])
  );
  assert.equal(missingBastion.approved, false);
  assert.ok(missingBastion.reasoning.includes("AUENRIX, GHOST, BASTION"));

  const duplicateGhost = await wyerdTraderTradingCycle(
    ctx,
    cycleInput([verdict("BASTION"), verdict("GHOST"), verdict("GHOST")])
  );
  assert.equal(duplicateGhost.approved, false);
});

test("a properly formed cycle with 3/3 consensus and no veto is approved", async () => {
  const result = await wyerdTraderTradingCycle(
    ctx,
    cycleInput([
      verdict("AUENRIX", { verdict: "BUY", asset: "DOGE", confidence: 80 }),
      verdict("GHOST", { verdict: "BUY", asset: "DOGE", confidence: 90 }),
      verdict("BASTION", { verdict: "BUY", asset: "DOGE", confidence: 70 }),
    ])
  );
  assert.equal(result.approved, true);
  assert.equal(result.action, "BUY");
  assert.equal(result.asset, "DOGE");
  assert.equal(result.consensus_count, 3);
});

test("any FAILED verdict fails the whole cycle closed, regardless of the other two", async () => {
  const result = await wyerdTraderTradingCycle(
    ctx,
    cycleInput([
      verdict("AUENRIX", { verdict: "FAILED" }),
      verdict("GHOST", { verdict: "BUY", asset: "DOGE" }),
      verdict("BASTION", { verdict: "BUY", asset: "DOGE" }),
    ])
  );
  assert.equal(result.approved, false);
  assert.ok(result.reasoning.includes("model failure"));
});

test("BASTION veto is a hard stop even with unanimous 3/3 consensus otherwise", async () => {
  const result = await wyerdTraderTradingCycle(
    ctx,
    cycleInput([
      verdict("AUENRIX", { verdict: "BUY", asset: "DOGE" }),
      verdict("GHOST", { verdict: "BUY", asset: "DOGE" }),
      verdict("BASTION", { verdict: "BUY", asset: "DOGE", veto: true, reasoning: "market too volatile" }),
    ])
  );
  assert.equal(result.approved, false);
  assert.equal(result.veto_active, true);
  assert.ok(result.reasoning.includes("market too volatile"));
});

test("BASTION's confidence floor (60%) is binding even without an active veto", async () => {
  const result = await wyerdTraderTradingCycle(
    ctx,
    cycleInput([
      verdict("AUENRIX", { verdict: "BUY", asset: "DOGE" }),
      verdict("GHOST", { verdict: "BUY", asset: "DOGE" }),
      verdict("BASTION", { verdict: "BUY", asset: "DOGE", veto: false, confidence: 59 }),
    ])
  );
  assert.equal(result.approved, false);
  assert.ok(result.reasoning.includes("60"));
});

test("BASTION at exactly the 60% floor is not refused by the floor check", async () => {
  const result = await wyerdTraderTradingCycle(
    ctx,
    cycleInput([
      verdict("AUENRIX", { verdict: "BUY", asset: "DOGE" }),
      verdict("GHOST", { verdict: "BUY", asset: "DOGE" }),
      verdict("BASTION", { verdict: "BUY", asset: "DOGE", veto: false, confidence: 60 }),
    ])
  );
  assert.equal(result.approved, true);
});

test("no 2/3 consensus on the same action results in a HOLD, not an approval", async () => {
  const result = await wyerdTraderTradingCycle(
    ctx,
    cycleInput([
      verdict("AUENRIX", { verdict: "BUY", asset: "DOGE" }),
      verdict("GHOST", { verdict: "SELL", asset: "AVAX" }),
      verdict("BASTION", { verdict: "HOLD", asset: "NONE" }),
    ])
  );
  assert.equal(result.approved, false);
  assert.equal(result.action, "HOLD");
});

test("2/3 consensus on HOLD is treated as no actionable consensus, not an approved HOLD trade", async () => {
  const result = await wyerdTraderTradingCycle(
    ctx,
    cycleInput([
      verdict("AUENRIX", { verdict: "HOLD", asset: "NONE" }),
      verdict("GHOST", { verdict: "HOLD", asset: "NONE" }),
      verdict("BASTION", { verdict: "BUY", asset: "DOGE" }),
    ])
  );
  assert.equal(result.approved, false);
  assert.equal(result.action, "HOLD");
});

test("2/3 consensus (not unanimous) still approves with the correct consensus_count", async () => {
  const result = await wyerdTraderTradingCycle(
    ctx,
    cycleInput([
      verdict("AUENRIX", { verdict: "BUY", asset: "AVAX", confidence: 80 }),
      verdict("GHOST", { verdict: "BUY", asset: "AVAX", confidence: 70 }),
      verdict("BASTION", { verdict: "SELL", asset: "DOGE", confidence: 65 }),
    ])
  );
  assert.equal(result.approved, true);
  assert.equal(result.action, "BUY");
  assert.equal(result.asset, "AVAX");
  assert.equal(result.consensus_count, 2);
  assert.equal(result.confidence, 75); // average of the 2 concurring verdicts, not all 3
});

test("every result honestly self-reports hil_gate: BYPASSED_POC, approved or not", async () => {
  const approved = await wyerdTraderTradingCycle(
    ctx,
    cycleInput([verdict("AUENRIX", { asset: "DOGE" }), verdict("GHOST", { asset: "DOGE" }), verdict("BASTION", { asset: "DOGE" })])
  );
  const refused = await wyerdTraderTradingCycle(ctx, {});
  assert.equal(approved.hil_gate.status, "BYPASSED_POC");
  assert.equal(refused.hil_gate.status, "BYPASSED_POC");
});
