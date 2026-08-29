import * as net from "net";
import type { RouterContext } from "../core/router";

const SOCKET_PATH = "/run/feneris/feneris.sock";
const TIMEOUT_MS  = 5000;

interface FenerisState {
  system_state: string;
  last: Record<string, unknown> | null;
}

interface FenerisStatusResult {
  system_state: string;
  last_event:   string | null;
  last_ts:      string | null;
  summary:      string;
  hil_gate: { status: "BYPASSED_POC"; note: string };
}

function queryFenerisSocket(): Promise<FenerisState> {
  return new Promise((resolve, reject) => {
    const sock  = net.createConnection(SOCKET_PATH);
    let buf     = "";
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error("Feneris socket timeout"));
    }, TIMEOUT_MS);

    sock.on("connect", () => {
      sock.write(JSON.stringify({ cmd: "state" }) + "\n");
    });

    sock.on("data", (chunk) => {
      buf += chunk.toString();
      const line = buf.split("\n")[0].trim();
      if (line) {
        clearTimeout(timer);
        sock.destroy();
        try { resolve(JSON.parse(line) as FenerisState); }
        catch { reject(new Error("Feneris: malformed response")); }
      }
    });

    sock.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

export async function fenerisSecurityStatus(ctx: RouterContext): Promise<FenerisStatusResult> {
  const { sessionId, ledger } = ctx;

  await ledger?.append(sessionId, "feneris.security.status.start", {
    hil_gate: { status: "BYPASSED_POC", note: "LIVE_SYSTEM_WOULD_PAUSE_HERE: human approval required before reading security state" },
  });

  let state: FenerisState;
  try {
    state = await queryFenerisSocket();
  } catch (err: unknown) {
    const msg          = err instanceof Error ? err.message : String(err);
    const isPermission = msg.includes("EACCES") || msg.includes("EPERM");

    await ledger?.append(sessionId, "feneris.security.status.error", {
      error: msg, permission_denied: isPermission,
    });

    const summary = isPermission
      ? "Socket permission denied — echostation user not in feneris group. Run: sudo groupadd feneris && sudo usermod -aG feneris echostation && sudo systemctl restart feneris-watchdog"
      : `Socket unreachable: ${msg}`;

    return {
      system_state: "CONTROLLED",
      last_event:   null,
      last_ts:      null,
      summary,
      hil_gate: { status: "BYPASSED_POC", note: "LIVE_SYSTEM_WOULD_PAUSE_HERE: human approval required before reading security state" },
    };
  }

  const systemState = state.system_state ?? "UNKNOWN";
  const last        = state.last ?? null;
  const lastEvent   = last ? String(last.event_type ?? last.event ?? "unknown") : null;
  const lastTs      = last?.ts ? String(last.ts).substring(0, 19).replace("T", " ") : null;

  await ledger?.append(sessionId, "feneris.security.status.complete", {
    system_state: systemState,
    last_event:   lastEvent,
    last_ts:      lastTs,
  });

  let summary = `Feneris Security — ${systemState}`;
  if (systemState === "FAILED_CLOSED") {
    summary += ". Honeypot or circuit breaker tripped — review Feneris ledger.";
  } else if (systemState === "CONTROLLED") {
    summary += ". Anomaly detected and contained — monitoring active.";
  } else {
    summary += ". Network security nominal.";
  }
  if (lastEvent) summary += ` Last event: ${lastEvent}${lastTs ? " at " + lastTs : ""}.`;

  return {
    system_state: systemState,
    last_event:   lastEvent,
    last_ts:      lastTs,
    summary,
    hil_gate: { status: "BYPASSED_POC", note: "LIVE_SYSTEM_WOULD_PAUSE_HERE: human approval required before reading security state" },
  };
}
