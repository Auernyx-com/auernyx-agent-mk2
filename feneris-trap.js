/**
 * Feneris Trap — deception layer for Avars CF Workers.
 *
 * Unknown routes get a convincing fake response with an embedded canary trap ID.
 * Hit state and event log live in R2 (AVRS_DATA). Two-tier escalation under the
 * Feneris persona. No external dependencies — requires only env.AVRS_DATA (R2).
 *
 * Writes are handed to ctx.waitUntil(): an un-awaited promise can be cancelled
 * once the response is returned, which silently dropped every hit and log.
 *
 * Silent phase (hits 1–2): fake 200, canary ID in body.
 * Tier 1 (hit 3):          mask drops — Knight's Tale / Daniel 5:27.
 * Tier 2 (hit 4+, canary): door closes — "you're marked."
 */

const ESCALATION_THRESHOLD = 3;
const ESCALATION_MESSAGE_FIRST =
  'you have been weighed, you have been measured, and you have been found wanting.';
const ESCALATION_MESSAGE_CONTINUED =
  "you reached into the dark. something woke up. you're marked.";

function trapId() {
  const ts   = Date.now();
  const rand = Array.from(crypto.getRandomValues(new Uint8Array(3)))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
  return `TRAP_${ts}_${rand}`;
}

function sourceIp(request) {
  return (
    request.headers.get('CF-Connecting-IP') ??
    request.headers.get('X-Forwarded-For')?.split(',')[0].trim() ??
    'unknown'
  );
}

async function getState(env, ip) {
  try {
    const obj = await env.AVRS_DATA.get(`honeypot/state/${ip}.json`);
    if (obj) return JSON.parse(await obj.text());
  } catch {}
  return { count: 0, traps: [] };
}

function keepAlive(ctx, promise) {
  if (ctx?.waitUntil) ctx.waitUntil(promise);
}

function saveState(env, ctx, ip, state) {
  keepAlive(ctx, env.AVRS_DATA.put(
    `honeypot/state/${ip}.json`,
    JSON.stringify(state),
  ).catch(err => console.error('feneris-trap: state write failed', err)));
}

function logEvent(env, ctx, type, ip, tid, extra = {}) {
  const ts   = new Date().toISOString();
  const date = ts.split('T')[0];
  keepAlive(ctx, env.AVRS_DATA.put(
    `honeypot/events/${date}/${Date.now()}-${tid.slice(8, 16)}.json`,
    JSON.stringify({ timestamp: ts, type, ip, trap_id: tid, system_state: 'FAILED_CLOSED', ...extra }),
  ).catch(err => console.error('feneris-trap: event write failed', err)));
}

function checkCanary(state, bodyText) {
  for (const tid of (state.traps ?? [])) {
    if (bodyText.includes(tid.slice(0, 12))) return tid;
  }
  return null;
}

/**
 * Intercept an unknown route. Call this at the bottom of a worker's fetch handler
 * in place of the default 404.
 *
 * @param {Request}  request
 * @param {object}   env          - CF Worker env bindings (needs env.AVRS_DATA)
 * @param {Function} fakeResponse - (tid: string) => Response — surface-specific fake
 * @param {object}   ctx          - CF Worker ExecutionContext (keeps R2 writes alive)
 * @returns {Promise<Response>}
 */
export async function fenerisTrap(request, env, fakeResponse, ctx) {
  const ip       = sourceIp(request);
  const bodyText = await request.clone().text().catch(() => '');
  const state    = await getState(env, ip);

  const canaryHit   = checkCanary(state, bodyText);
  state.count       = (state.count ?? 0) + 1;
  const hitNumber   = state.count;
  const tid         = trapId();
  state.traps       = [...(state.traps ?? []), tid].slice(-20);

  const forceEscalate = canaryHit !== null;

  if (canaryHit) {
    logEvent(env, ctx, 'HONEYPOT_FOLLOW', ip, canaryHit, {
      follow_payload: bodyText.slice(0, 512),
      hit_number: hitNumber,
    });
  }

  const escalating = forceEscalate || hitNumber >= ESCALATION_THRESHOLD;
  let response;

  if (escalating) {
    const firstHit = hitNumber === ESCALATION_THRESHOLD && !forceEscalate;
    const msg      = firstHit ? ESCALATION_MESSAGE_FIRST : ESCALATION_MESSAGE_CONTINUED;
    const tier     = firstHit ? 1 : 2;

    logEvent(env, ctx, 'HONEYPOT_ESCALATION', ip, tid, { tier, hit_number: hitNumber, message: msg });

    response = new Response(
      JSON.stringify({ error: msg }),
      { status: 403, headers: { 'Content-Type': 'application/json' } },
    );
  } else {
    logEvent(env, ctx, 'HONEYPOT_TRAP', ip, tid, { hit_number: hitNumber });

    response = fakeResponse
      ? fakeResponse(tid)
      : new Response(
          JSON.stringify({ status: 'WITHIN_TOLERANCE', queued: true, id: tid.slice(0, 12) }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
  }

  saveState(env, ctx, ip, state);
  return response;
}
