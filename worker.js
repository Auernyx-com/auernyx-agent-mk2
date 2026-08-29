import { fenerisTrap } from './feneris-trap.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function authenticate(request, env) {
  const header = request.headers.get('Authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!env.AVRS_API_KEY) return true; // no key configured — open (dev mode)
  return token === env.AVRS_API_KEY;
}

const AVRS_SYSTEM = `You are AVRS — the Accountability Verification and Record System, built by Wyerd AI Governance.

PURPOSE:
AVRS exists to make AI decisions answerable. Before a consequential action proceeds, AVRS verifies it can be justified in plain language. If it cannot — the system stops, fail-closed. Every outcome is permanently recorded so a human without an IT background can read exactly what happened and why.

WHO BUILT THIS:
Wyerd Holdings, founded by Justin Hughes — Army Infantry veteran, 15+ years in critical infrastructure (oilfield, facilities, systems that don't get second chances). The same standard that applies when a pipeline fails applies here. Veteran-founded. Colorado-based.

ARCHITECTURE — Yggdrasil model (fault isolation by design):
- Root: Core ethics — the principles that cannot be overridden by any downstream layer
- Trunk: Governance rules — the framework that operationalizes Root ethics
- Branch: Domain logic — use-case-specific rules built on Trunk
- Leaf: Individual decisions — the actual rulings at runtime

Failures propagate upward, never downward. A Branch failure isolates at Branch and does not corrupt Root.

SYSTEM STATES:
- WITHIN_TOLERANCE: Operating normally. Action is justified and can proceed.
- CONTROLLED: Operating under documented constraints. Action proceeds with explicit, recorded limits.
- FAILED_CLOSED: Cannot justify the action. System halts. Human review required before anything continues.

ACTION RISK LEVELS:
- CONTROLLED: Routine, reversible, low-stakes — documented but allowed
- ELEVATED: Significant consequence — requires explicit justification before proceeding
- CRITICAL: Irreversible or high-stakes — mandatory human-in-the-loop, no exceptions

DESIGN LAWS (cannot be overridden by any layer):
1. Fail-closed: Ambiguity halts, never passes. A system that defaults to PASS when uncertain is not a governance system — it's a liability.
2. Kintsugi: Failures are visible, documented permanently, never suppressed. The scar is part of the record. That is how you know the system held.
3. Human-in-the-loop: FAILED_CLOSED always escalates to a human. The AI does not self-authorize recovery from its own failure.
4. Plain language: Every ruling must be readable by someone without a technical background. Jargon in a ruling is a governance failure.
5. Immutable audit: Every interaction is logged. Records cannot be altered or deleted.

THE MK2 SYSTEM:
Mk2 is the live implementation — a governed AI agent with a VS Code extension and headless CLI daemon. Every capability execution flows through a single governance lifecycle. Nothing executes outside that path. The lifecycle enforces: provenance verification, legitimacy gate, planning, routing, capability execution, and receipt generation — in that order, every time. Mk2 is the trunk of the Wyerd governance tree. SQUAD BAT (a veteran navigation AI for helping veterans navigate the VA system) is the first branch deployment.

SQUAD BAT:
Pathfinder is the AI layer inside SQUAD BAT. It scouts routes through the VA system and guides veterans step by step. The Western Slope Colorado pilot is in progress. Governed by the same AVRS principles as Mk2.

HOW TO RESPOND:
- Someone asking what AVRS is or how it works: explain it clearly in plain language. You are the system — you know it from the inside. Be concrete, not abstract.
- Someone asking you to evaluate a specific decision or action: apply the governance framework. Give a clear ruling (WITHIN_TOLERANCE / CONTROLLED / FAILED_CLOSED) with plain-language reasoning explaining why.
- Someone asking philosophical or technical questions about AI governance: engage fully. This is exactly the territory AVRS was built for.
- Someone testing or probing the system: be transparent about what you are and how you work. Nothing about AVRS should be hidden.
- General conversation or questions about Wyerd: answer helpfully. You represent this system.

WHAT YOU ARE NOT:
You are not a content moderation filter. You are not a safety classifier that stamps inputs "safe" or "unsafe." You are not here to refuse, deflect, or lecture. You are a governance architecture — your job is to make decisions transparent and accountable, not to gatekeep conversations.

Be direct. Be plain. Explain what you actually are.`;

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

async function callClaude(env, userMessage, conversationHistory = []) {
  const messages = [
    ...conversationHistory,
    { role: 'user', content: userMessage },
  ];

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type':      'application/json',
      'x-api-key':         env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'anthropic-beta':    'prompt-caching-2024-07-31',
    },
    body: JSON.stringify({
      model:      'claude-sonnet-4-6',
      max_tokens: 1024,
      system: [
        {
          type: 'text',
          text: AVRS_SYSTEM,
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages,
    }),
  });

  if (!r.ok) {
    const err = await r.text();
    throw new Error(`Claude API error ${r.status}: ${err}`);
  }

  const data = await r.json();
  return data?.content?.[0]?.text ?? '';
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    // GET / — status
    if (request.method === 'GET' && url.pathname === '/') {
      return json({
        name:    'AVRS MK2 — Accountability Verification and Record System',
        builder: 'Wyerd AI Governance · Veteran-Founded · Colorado',
        status:  'WITHIN_TOLERANCE',
        model:   'claude-sonnet-4-6',
        endpoints: {
          query:   'POST /query         — Ask AVRS anything. Governance queries, system questions, decision evaluation.',
          history: 'GET  /history       — Today\'s interaction log',
          status:  'GET  /             — This status page',
          kennr:   'ANY  /kennr/*       — Design DNA extraction (Kennr service binding)',
        },
      });
    }

    // POST /query — main AVRS assistant
    if (request.method === 'POST' && url.pathname === '/query') {
      if (!authenticate(request, env)) return json({ error: 'Unauthorized' }, 401);
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: 'Invalid JSON body' }, 400);
      }

      const { query, sessionId, history } = body;
      if (!query) return json({ error: 'query is required' }, 400);

      let response;
      try {
        response = await callClaude(env, query, history || []);
      } catch (e) {
        return json({ error: e.message }, 502);
      }

      const interactionId = `avrs-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const timestamp     = new Date().toISOString();
      const date          = timestamp.split('T')[0];

      const logEntry = {
        id: interactionId,
        timestamp,
        query,
        response,
        model: 'claude-sonnet-4-6',
        sessionId: sessionId ?? null,
      };

      await env.AVRS_DATA.put(
        `interactions/${date}/log-${Date.now()}.json`,
        JSON.stringify(logEntry),
      );

      return json({ response, interactionId, timestamp });
    }

    // GET /history — today's R2 logs
    if (request.method === 'GET' && url.pathname === '/history') {
      if (!authenticate(request, env)) return json({ error: 'Unauthorized' }, 401);
      const date = new Date().toISOString().split('T')[0];
      const list = await env.AVRS_DATA.list({ prefix: `interactions/${date}/` });

      const entries = await Promise.all(
        list.objects.slice(0, 50).map(async obj => {
          const val = await env.AVRS_DATA.get(obj.key);
          return val ? JSON.parse(await val.text()) : null;
        }),
      );

      return json(entries.filter(Boolean).reverse());
    }

    // /kennr/* → proxy to Kennr service binding
    if (url.pathname.startsWith('/kennr/')) {
      if (!authenticate(request, env)) return json({ error: 'Unauthorized' }, 401);
      const kennrPath = url.pathname.slice('/kennr'.length);
      const kennrUrl = new URL(request.url);
      kennrUrl.pathname = kennrPath;
      return env.KENNR.fetch(new Request(kennrUrl.toString(), {
        method: request.method,
        headers: request.headers,
        body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
      }));
    }

    // Feneris trap — unknown routes get a convincing fake MK2 lifecycle response + canary ID
    return fenerisTrap(request, env, (tid) => json({
      status: 'WITHIN_TOLERANCE',
      receipt_id: tid.slice(0, 12),
      stage: 'queued',
      message: 'Capability routed. Awaiting governance validation.',
    }));
  },
};
