function getToken() {
  return document.getElementById("token").value.trim();
}

function wireShowToken() {
  const tokenInput = document.getElementById("token");
  const show = document.getElementById("showToken");
  if (!tokenInput || !show) return;
  show.addEventListener("change", () => {
    tokenInput.type = show.checked ? "text" : "password";
  });
}

function getActorId() {
  return document.getElementById("actorId").value.trim();
}

function getConfirm() {
  return document.getElementById("confirm").value.trim();
}

function headers() {
  return {
    "Content-Type": "application/json",
    "x-mk2-token": getToken(),
  };
}

function setOut(text) {
  document.getElementById("output").textContent = text;
}

async function apiGet(path) {
  const res = await fetch(path, { headers: headers() });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.message || body.error || `HTTP ${res.status}`);
  return body;
}

async function apiPost(path, payload) {
  const res = await fetch(path, { method: "POST", headers: headers(), body: JSON.stringify(payload) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.message || body.error || `HTTP ${res.status}`);
  return body;
}

async function refresh() {
  const hint = document.getElementById("authHint");
  hint.textContent = "";
  try {
    const status = await apiGet("/api/status");
    document.getElementById("status").textContent = JSON.stringify(status, null, 2);
  } catch (e) {
    hint.textContent = String(e.message || e);
    document.getElementById("status").textContent = "Unable to fetch status.";
  }
}

function requireConfirmOrThrow() {
  const actorId = getActorId();
  const confirm = getConfirm();
  const expected = `APPLY ${actorId}`;
  if (!actorId) throw new Error("actorId required");
  if (confirm !== expected) throw new Error(`confirmation must equal '${expected}'`);
}

document.getElementById("refresh").addEventListener("click", refresh);

wireShowToken();

document.getElementById("runGate").addEventListener("click", async () => {
  setOut("Running Mk2 gate...");
  try {
    const result = await apiPost("/api/run/gate", { actorId: getActorId() });
    setOut(JSON.stringify(result, null, 2));
    await refresh();
  } catch (e) {
    setOut(String(e.message || e));
  }
});

document.getElementById("runMomentum").addEventListener("click", async () => {
  setOut("Running momentum...");
  try {
    requireConfirmOrThrow();
    const requirePayload = document.getElementById("requirePayload").checked;
    const result = await apiPost("/api/run/momentum", { actorId: getActorId(), confirm: getConfirm(), requirePayload });
    setOut(JSON.stringify(result, null, 2));
    await refresh();
  } catch (e) {
    setOut(String(e.message || e));
  }
});

document.getElementById("runBastion").addEventListener("click", async () => {
  setOut("Running Bastion secondary adapter...");
  try {
    requireConfirmOrThrow();
    const result = await apiPost("/api/run/bastion-secondary", { actorId: getActorId(), confirm: getConfirm() });
    setOut(JSON.stringify(result, null, 2));
    await refresh();
  } catch (e) {
    setOut(String(e.message || e));
  }
});

refresh();
