// Legitimacy Gate for Mk2
// Checks intent before planning

export type LegitimacyResult =
    | { ok: true }
    | {
          ok: false;
          code: "illegitimate_request";
          reason: string;
      };

// A bare topic word is not intent to do harm with it. "scan repo for a
// hardcoded password" and "governance self test for MFA hygiene" are
// ordinary, legitimate security work that happens to name these topics —
// blocking on the word alone made every one of those a false positive.
// Requiring a nearby solicitation/exfiltration verb (get/obtain/steal/
// share/send/give/leak/dump/grab/retrieve someone else's X) keeps the
// gate aimed at the actual red flag — asking Mk2 to go fetch or hand over
// the sensitive thing — without losing the topic entirely. Impersonation
// and phishing are left as pure topic matches: unlike "password" or
// "bank", those words are themselves almost always the bad act, not an
// ordinary security-work topic that happens to come up.
// Known residual limitation, not fully solved by this pattern: it catches
// verb+noun co-occurrence, not who the noun belongs to. "send my own
// password to my email" or "get the bank statement from downloads" still
// trip this — the regex has no way to tell a self-referential, benign
// request apart from a third-party solicitation. A real fix needs
// possessive/pronoun disambiguation, not a better regex. This gate is
// still a coarse pre-filter, not a substitute for the approval/identity
// gates downstream in router.ts, which is where actual enforcement lives.
const SOLICITATION_VERBS = "(?:get|obtain|steal|extract|share|send|give|leak|dump|grab|retrieve|access)";

function solicitationPattern(noun: string): RegExp {
    return new RegExp(`\\b${SOLICITATION_VERBS}\\b[^.?!]{0,40}?${noun}`);
}

// Minimal legitimacy gate: blocks intents that look like scams/impersonation/credential theft.
// This is deliberately conservative and can be expanded as Mk2 evolves.
export function legitimacyGate(rawIntent: string): LegitimacyResult {
    const text = rawIntent.trim().toLowerCase();

    const redFlags: Array<{ match: RegExp; reason: string }> = [
        { match: /\bimpersonat(e|ion)\b/, reason: "Impersonation request" },
        { match: /\bphish(ing)?\b/, reason: "Phishing request" },
        {
            match: solicitationPattern("\\b(?:password|2fa|otp|mfa)\\b"),
            reason: "Credential/2FA related request",
        },
        {
            match: solicitationPattern("\\b(?:wire\\s+transfer|bank|crypto\\s+wallet)\\b"),
            reason: "Financial transfer / account takeover adjacent",
        },
        {
            match: solicitationPattern("\\b(?:social\\s+security|ssn|passport)\\b"),
            reason: "Sensitive identity theft adjacent",
        },
    ];

    for (const rf of redFlags) {
        if (rf.match.test(text)) {
            return { ok: false, code: "illegitimate_request", reason: rf.reason };
        }
    }

    return { ok: true };
}
