// Legitimacy Gate for Mk2
// Checks intent before planning

export function check(intent: string): { allow: boolean; reason?: string } {
  // Minimal stub: allow all intents except empty or 'malware'
  if (!intent || intent.toLowerCase().includes("malware")) {
    return { allow: false, reason: "Intent is empty or forbidden." };
  }
  return { allow: true };
}export type LegitimacyResult =
    | { ok: true }
    | {
          ok: false;
          code: "illegitimate_request";
          reason: string;
      };

// Minimal legitimacy gate: blocks intents that look like scams/impersonation/credential theft.
// This is deliberately conservative and can be expanded as Mk2 evolves.
export function legitimacyGate(rawIntent: string): LegitimacyResult {
    const text = rawIntent.trim().toLowerCase();

    const redFlags: Array<{ match: RegExp; reason: string }> = [
        { match: /\bimpersonat(e|ion)\b/, reason: "Impersonation request" },
        { match: /\bphish(ing)?\b/, reason: "Phishing request" },
        { match: /\bpassword\b|\b2fa\b|\botp\b|\bmfa\b/, reason: "Credential/2FA related request" },
        { match: /\bwire\s+transfer\b|\bbank\b|\bcrypto\s+wallet\b/, reason: "Financial transfer / account takeover adjacent" },
        { match: /\bsocial\s+security\b|\bssn\b|\bpassport\b/, reason: "Sensitive identity theft adjacent" },
    ];

    for (const rf of redFlags) {
        if (rf.match.test(text)) {
            return { ok: false, code: "illegitimate_request", reason: rf.reason };
        }
    }

    return { ok: true };
}
