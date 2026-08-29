# Security Incident Report: Cross-Org Authentication Gaps
## Date: 2026-08-29

### Executive Summary

A live, unauthenticated data-collection endpoint was discovered on the SQUAD BAT / Pathfinder veteran-navigation tool on 2026-08-29, found by Justin's own adversarial testing (declaring himself "the Architect" against both AVRS and SQUAD and comparing what each system disclosed). Investigating it led to a full authentication audit across every Cloudflare Worker in the Auernyx-com and Ghostwolf101 accounts, which found the same class of bug — auth checks that fail *open* instead of closed, or don't exist at all — independently present in five separate codebases.

**Impact:** `pathfinder-worker`'s intake and chat endpoints, and the `squad.wyerd.org` frontend, were reachable by anyone with zero authentication for an unknown period, meaning veteran intake data (discharge status, VA history, disability rating, location, crisis flags) could have been submitted and processed by anyone, not just through the intended invite-only beta gate. **No evidence of actual exploitation was found or is claimed — this report documents exposure, not a confirmed breach.**

All five findings were fixed same-day. One (`wyerd-trader`) is fixed in code but not yet deployed to production as of this report — see Open Items.

---

### Root Cause: Why This Existed for as Long as It Did

This is the part of the record that matters most, in the spirit of the project's own Kintsugi law — the scar stays visible, not hidden.

1. **The SQUAD Access gate was removed deliberately, under real constraints, and never restored.** Justin was running Cloudflare Access's email-OTP beta gate on `squad.wyerd.org` because that was what was affordable at the time. He removed it before relocating, didn't discover how serious the resulting exposure was until later, and by then only had a phone available — no practical way to fix it remotely. It sat open from that point until tonight.

2. **A roughly two-month gap in active development** (see [[auernyx-repo-audit]] in project memory) meant nobody was looking at any of these systems during the window the gate was down.

3. **The same auth anti-pattern was independently reinvented, not copy-pasted, across separate codebases** — `auernyx-agent-mk2`'s `authenticate()` and `wyerd-trader`'s `CONDUCTOR_SECRET` check both fail open on a missing secret, written in different syntax, by what were effectively separate unsupervised development sessions with no shared authentication component to defer to. `kennr-worker` never had auth logic at all. This is a structural problem, not a one-off mistake: there was no single, shared "authorization must precede capability" implementation for these workers to use, so each one got its own — and each one, independently, got it wrong in the same direction (open instead of closed).

4. **Cloudflare's own routing model was misunderstood in the original design.** CORS restricting a frontend's allowed origin was treated as if it were an access control on the API itself. It isn't — CORS is a browser-enforced restriction on `fetch()` calls from a webpage; a direct `curl` request bypasses it entirely, and every worker's raw `*.workers.dev` URL is reachable regardless of what Cloudflare Access is configured on the paired custom domain, because Access binds to a zone/hostname the `workers.dev` subdomain was never part of.

---

### Findings, by Repository

#### `pathfinder-worker` — CRITICAL, confirmed live
- `/process` and `/chat` had **no authentication of any kind**. Verified live: a direct unauthenticated `curl POST` to `/process` on the raw `workers.dev` URL returned a full AI-generated response, HTTP 200.
- The frontend also hardcoded this raw worker URL in client-side JS, so even a working Access gate on the Pages site would not have protected the API calls themselves.
- **Disposition:** Full takedown. The worker script was deleted from Cloudflare entirely (not just gated) and `squad.wyerd.org` was redeployed with a plain maintenance notice instead of the intake tool, until the real fix — a public/admin split, not a patch — is built. See Open Items.

#### `squad.wyerd.org` (`wyerd-squad`) — CRITICAL, confirmed live
- The Cloudflare Access application protecting the site had been removed (see Root Cause #1) and was never restored. `/tool/` — the actual veteran intake form — loaded directly with HTTP 200, no gate, no redirect to any login.
- **Disposition:** Site content replaced with a maintenance page ("temporarily offline for a security update," VA main line + Crisis Line included so nobody in real need is stranded). Separately, the client-side session vault (`encryptSession`/`decryptSession`) was fully audited: confirmed to be real Web Crypto API usage, correct random salt/IV generation, and the passphrase/plaintext confirmed to never leave the device. One real gap found and fixed: PBKDF2 iteration count was 150,000 (reasonable a few years ago), bumped to 600,000 (current OWASP guidance). Existing vaults will need to be reset — the iteration count is baked into the derived key, no migration path exists.

#### `auernyx-agent-mk2` — latent, not confirmed exploited
- `authenticate()` in `worker.js`: `if (!env.AVRS_API_KEY) return true` — an unset secret silently opened `/query`, `/history`, and `/kennr/*` instead of blocking them. The key was correctly configured at the time of discovery, so this was safe by configuration, not by design.
- **Disposition:** Fixed to fail closed (`if (!env.AVRS_API_KEY) return false`). PR #150, merged, deployed live via the repo's Cloudflare Workers Build integration. Confirmed via `npm run verify` and the full test suite (9/9 passing) before merge.

#### `wyerd-trader` — latent + one confirmed-live zero-auth endpoint
- The exact same fail-open pattern as AVRS, written differently (`if (secret && header !== secret)` — silently skips the check entirely when `CONDUCTOR_SECRET` is unset), present in **two places**: `/api/ledger` and `handleGovernedCycle` (the actual trade-governance endpoint).
- `/api/run-cycle` had **zero authentication of any kind** — confirmed live, anyone could trigger a real trading cycle on demand, unlimited, bypassing the intended 10-minute cadence.
- **Disposition:** All three fixed in code and pushed to `main`. **Not yet deployed to production as of this report** — see Open Items. This account (`wyerdfinace@proton.me`) is separate from the main Cloudflare account used for everything else tonight, and the cached deploy credential found for it had expired past refreshing.

#### `skadi` — confirmed live
- `/debug/fsq` had no authentication and returned a prefix of the live Foursquare API key plus a real proxied API call to anyone who requested it. `/hunt` and `/debug/osm` had no authentication either.
- **Disposition:** All three gated behind a shared `x-admin-token` header, fail-closed on a missing token. Deployed and confirmed live (`HTTP 401`). The daily cron trigger calls the scan function directly, not through the HTTP route, so the scheduled job is unaffected.

#### `kennr-worker` + `kennr` (Chrome extension) — confirmed live, cross-user
- No authentication logic existed anywhere in the codebase. `/api/extractions` and `/api/projects` ran flat `SELECT * FROM ...` queries with no owner column and no per-user scoping of any kind. `DELETE /api/extractions/:id` had no auth either.
- **Real-world exposure:** the Kennr Chrome extension is published publicly (`Ghostwolf101/kennr`, public repo). Had it had real installers, any one of them could have listed, read, or deleted any other installer's extracted data. **Confirmed 0 real users at time of discovery — the vulnerability was real, the exposure window had no actual victims.**
- **Disposition:** Kennr was confirmed as intended to be a single-user tool, not a multi-tenant product, so the fix locks the entire API behind one admin token rather than building per-user isolation. The extension was updated (`popup.html`/`popup.js`) to send that token on every request via a new settings field. Deployed and confirmed live (`HTTP 401` on the previously-open endpoints).

---

### Governance Principle Violated

Every finding here is the same violation, stated once: **a missing or absent credential was treated as an open door instead of a closed one.** This directly contradicts the fail-closed law already stated as non-negotiable elsewhere in this project — "a system that defaults to PASS when uncertain is not a governance system, it's a liability" (AVRS's own system prompt) — the bug just hadn't been checked for in the auth layer specifically until tonight.

### Remediation Actions Taken

1. ✅ `pathfinder-worker` deleted from Cloudflare entirely
2. ✅ `squad.wyerd.org` replaced with a maintenance page, cache purged, verified live on every path (`/`, `/tool/`, `/tool/index.html`)
3. ✅ `auernyx-agent-mk2`'s `authenticate()` fixed, merged, deployed (PR #150)
4. ✅ `wyerd-trader`'s three findings fixed in code, pushed to `main`
5. ✅ `skadi`'s three endpoints gated, deployed, verified live
6. ✅ `kennr-worker` fully gated + extension updated, deployed, verified live
7. ✅ `wyerd-squad` vault PBKDF2 hardened (150k → 600k), pushed
8. ✅ All new secrets recorded in `/home/echostation/.wyerd-trader-keys` (600 permissions), not left only in conversation

### Open Items

1. **`wyerd-trader` fix not yet deployed to production.** Code is correct and in `main`; the live worker (`weyrd-trader-bot.wyerdfinace.workers.dev`) is still running the old, vulnerable version as of this report. Needs fresh deploy credentials for the `wyerdfinace@proton.me` Cloudflare account.
2. **The real long-term fix for SQUAD is not built yet.** Taking the site down was the correct immediate containment, not the fix. The actual fix in progress: a public tier with zero server-side disclosure capability by design (already true for the client-side vault), and a separate closed admin session gated by real 2FA (Cloudflare Access + GitHub OAuth, chosen specifically because it reuses GitHub's existing 2FA rather than hand-rolling another auth system) for anything privileged — feedback review, complaint data, governance logs. `squad.wyerd.org` stays down until this exists.
3. **The GitHub+2FA Cloudflare Access identity provider is partially configured, not functional.** A GitHub OAuth App exists (credentials recorded in `.wyerd-trader-keys`). The Cloudflare Access identity provider itself has not been successfully created — every attempt tonight hit a Cloudflare API token missing the required permission scope, and one attempt used the wrong credential type entirely (an R2 storage token, not a general API token) due to a dashboard navigation mix-up. This is inert, not risky — nothing depends on it yet.
4. Once proven on SQUAD, the same closed-session pattern should replace AVRS's `/history` endpoint's static bearer-key gate.

### Prevention Measures

1. **No more independently-reinvented auth checks.** Once the closed-session scaffolding exists for SQUAD, it becomes the shared component every other privileged surface defers to, instead of each worker rolling its own.
2. **Fail-closed is now the explicit, checked standard for every worker's auth gate**, not an assumption. The specific anti-pattern (`if (!secret) return true`, and its `if (secret && mismatch)` variant) is now a known signature to grep for in any future worker.
3. **CORS is not access control** — this was a real misunderstanding baked into the original SQUAD design and is now corrected in this record so it doesn't recur.
4. **Every new secret goes in the shared secrets file, not just this conversation** — already done for tonight's tokens.

### Lessons Learned

1. Removing a security control under real financial constraint is a reasonable tradeoff to make once — the failure was not restoring it once the constraint lifted, and not having a way to check on it remotely.
2. The same bug appearing independently in multiple codebases is a signal about process, not about any one session's carelessness — it means there was no shared, trusted place for "how does auth work here" to live.
3. Adversarial self-testing (Justin declaring himself "the Architect" against live systems) found what code review alone had not. That instinct is now part of how this project checks its own work, not a one-time event.
4. A takedown is a legitimate, sometimes-correct response to a live exposure — it beats leaving something broken-but-reachable while a proper fix gets built.

### Conclusion

Five real findings, one already confirmed live and exploitable, closed same-day across five repositories. The worst-case exposure (SQUAD veteran intake) is now fully offline rather than patched-but-still-guessable, and stays that way until the real architecture — not just a gate — is built. This report is the permanent record of why it happened and what changed; nothing here is deleted or softened for the next person who reads it.

**Status:** CONTAINED — Open Items above remain until closed.
**Prepared by:** Claude Code (security audit + remediation), directed and verified throughout by Justin Hughes (Ghostwolf101).
