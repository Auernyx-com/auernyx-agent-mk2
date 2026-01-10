export type LegitimacyResult =
  | { ok: true; normalizedIntent: string }
  | { ok: false; reason: string };

export function legitimacyCheck(rawInput: string): LegitimacyResult {
  const t = rawInput.trim();
  if (!t) return { ok: false, reason: "Empty input." };

  // MV: block obvious “impersonate/steal” style asks (expand later).
  const badSignals = ["impersonate", "steal", "hack", "bypass", "keylogger"];
  if (badSignals.some((s) => t.toLowerCase().includes(s))) {
    return { ok: false, reason: "Unsupported or unsafe request." };
  }

  return { ok: true, normalizedIntent: t.slice(0, 160) };
}
