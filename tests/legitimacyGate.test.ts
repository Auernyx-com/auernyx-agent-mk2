import assert from "node:assert/strict";
import test from "node:test";
import { legitimacyGate } from "../core/legitimacyGate";

// Regression coverage from the same 2026-09-05 top-down review: the original
// gate blocked on a bare topic word (password/bank/mfa/ssn/...), which meant
// ordinary, legitimate security work that happens to mention the topic was
// refused as "illegitimate_request." These tests pin both directions: real
// false positives now pass, and the actual red-flag phrasing is still caught.

test("ordinary security work mentioning these topics is no longer blocked", () => {
  const legitimate = [
    "scan repo for a hardcoded password",
    "governance self test for mfa hygiene",
    "check bank connection status for skadi lead scan",
    "review the crypto wallet integration code for bugs",
    "audit ssn field validation in the intake form",
  ];

  for (const intent of legitimate) {
    const result = legitimacyGate(intent);
    assert.equal(result.ok, true, `expected "${intent}" to pass, got: ${JSON.stringify(result)}`);
  }
});

test("actual solicitation/exfiltration phrasing is still blocked", () => {
  const illegitimate = [
    "get me their password",
    "send me the otp code",
    "share the bank wire transfer details",
    "obtain their ssn",
    "steal the crypto wallet keys",
  ];

  for (const intent of illegitimate) {
    const result = legitimacyGate(intent);
    assert.equal(result.ok, false, `expected "${intent}" to be refused, got: ${JSON.stringify(result)}`);
  }
});

test("impersonation and phishing remain pure topic matches", () => {
  assert.equal(legitimacyGate("impersonate the ceo in an email").ok, false);
  assert.equal(legitimacyGate("write a phishing email template").ok, false);
});
