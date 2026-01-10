#!/usr/bin/env python3
"""
Local-only Mk2 helper UI (NOT a bypass).

- Binds to 127.0.0.1 only.
- Requires an access token (env MK2_UI_TOKEN).
- All actions shell out to existing fail-closed tools:
  - tools/ci_gate.py
  - tools/mk2_momentum.ps1
  - tools/bastion_secondary.py
- Writes an append-only audit log with SHA-256 hashes:
  governance/alteration-program/logs/ui_actions.ndjson
"""

from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import os
import socket
import subprocess
import uuid
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[1]
UI_ROOT = REPO_ROOT / "tools" / "ui"


def utc_now_z() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def run(cmd: list[str], cwd: Path) -> dict[str, Any]:
    started = utc_now_z()
    p = subprocess.run(cmd, cwd=str(cwd), text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    out = (p.stdout or "")
    return {
        "startedAt": started,
        "finishedAt": utc_now_z(),
        "exitCode": p.returncode,
        "stdout": out,
        "stdoutSha256": sha256_text(out),
        "command": cmd,
    }


def git_info(repo: Path) -> dict[str, str]:
    head = run(["git", "rev-parse", "HEAD"], cwd=repo)
    br = run(["git", "rev-parse", "--abbrev-ref", "HEAD"], cwd=repo)
    return {
        "headCommit": (head["stdout"].strip().splitlines()[-1] if head["exitCode"] == 0 and head["stdout"].strip() else "unknown"),
        "branch": (br["stdout"].strip().splitlines()[-1] if br["exitCode"] == 0 and br["stdout"].strip() else "unknown"),
    }


def safe_read_text(path: Path, limit_bytes: int = 65536) -> str:
    if not path.exists():
        return ""
    data = path.read_bytes()
    if len(data) > limit_bytes:
        data = data[-limit_bytes:]
    return data.decode("utf-8", errors="replace")


def audit_log_path(repo: Path) -> Path:
    return repo / "governance" / "alteration-program" / "logs" / "ui_actions.ndjson"


def append_audit(repo: Path, obj: dict[str, Any]) -> None:
    log_path = audit_log_path(repo)
    log_path.parent.mkdir(parents=True, exist_ok=True)
    with log_path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(obj, sort_keys=True) + "\n")


def check_token(expected: str, provided: str | None) -> bool:
    if not expected:
        return False
    if not provided:
        return False
    return hmac.compare_digest(expected, provided)


def find_free_port(host: str, preferred: int, max_tries: int = 25) -> int:
    for port in range(preferred, preferred + max_tries):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                s.bind((host, port))
                return port
            except OSError:
                continue
    raise RuntimeError(f"No free port found starting at {preferred}")


class Mk2UI:
    def __init__(self, repo_root: Path, token: str):
        self.repo_root = repo_root
        self.token = token

    def status(self) -> dict[str, Any]:
        updates_incoming = self.repo_root / "updates" / "incoming"
        nested_updates_updates = self.repo_root / "updates" / "updates"
        apply_log = self.repo_root / "governance" / "alteration-program" / "logs" / "update_apply.ndjson"
        bastion_json = self.repo_root / "governance" / "alteration-program" / "logs" / "bastion_secondary.json"

        incoming_files: list[str] = []
        if updates_incoming.exists():
            for p in updates_incoming.rglob("*"):
                if p.is_file():
                    incoming_files.append(str(p.relative_to(self.repo_root)).replace("\\", "/"))
        incoming_files.sort()

        return {
            "serverTimeUtc": utc_now_z(),
            "repoRoot": str(self.repo_root),
            "git": git_info(self.repo_root),
            "paths": {
                "updatesIncoming": str(updates_incoming),
                "nestedUpdatesUpdatesExists": nested_updates_updates.exists(),
                "updateApplyLog": str(apply_log),
                "bastionSecondaryJson": str(bastion_json),
                "uiAuditLog": str(audit_log_path(self.repo_root)),
            },
            "updatesIncomingFiles": incoming_files,
            "lastUpdateApplyTail": safe_read_text(apply_log, limit_bytes=4096),
            "lastBastionSecondary": safe_read_text(bastion_json, limit_bytes=8192),
        }

    def run_gate(self, actor_id: str, request_id: str) -> dict[str, Any]:
        result = run(["python", str(self.repo_root / "tools" / "ci_gate.py")], cwd=self.repo_root)
        git = git_info(self.repo_root)
        append_audit(
            self.repo_root,
            {
                "event": "ui_action",
                "action": "ci_gate",
                "requestId": request_id,
                "actorId": actor_id,
                "at": utc_now_z(),
                "repoRoot": str(self.repo_root),
                "git": git,
                "result": {k: result[k] for k in ("exitCode", "stdoutSha256", "startedAt", "finishedAt")},
            },
        )
        return result

    def run_momentum(self, actor_id: str, request_id: str, require_payload: bool) -> dict[str, Any]:
        cmd = [
            "pwsh",
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            str(self.repo_root / "tools" / "mk2_momentum.ps1"),
            "-RepoRoot",
            str(self.repo_root),
            "-ActorId",
            actor_id,
        ]
        if require_payload:
            cmd.append("-RequirePayload")
        result = run(cmd, cwd=self.repo_root)
        git = git_info(self.repo_root)
        append_audit(
            self.repo_root,
            {
                "event": "ui_action",
                "action": "mk2_momentum",
                "requestId": request_id,
                "actorId": actor_id,
                "at": utc_now_z(),
                "repoRoot": str(self.repo_root),
                "git": git,
                "requirePayload": require_payload,
                "result": {k: result[k] for k in ("exitCode", "stdoutSha256", "startedAt", "finishedAt")},
            },
        )
        return result

    def run_bastion_secondary(self, actor_id: str, request_id: str) -> dict[str, Any]:
        result = run(
            ["python", str(self.repo_root / "tools" / "bastion_secondary.py"), "--repo", str(self.repo_root), "--actor", actor_id],
            cwd=self.repo_root,
        )
        git = git_info(self.repo_root)
        append_audit(
            self.repo_root,
            {
                "event": "ui_action",
                "action": "bastion_secondary",
                "requestId": request_id,
                "actorId": actor_id,
                "at": utc_now_z(),
                "repoRoot": str(self.repo_root),
                "git": git,
                "result": {k: result[k] for k in ("exitCode", "stdoutSha256", "startedAt", "finishedAt")},
            },
        )
        return result


class Handler(BaseHTTPRequestHandler):
    server_version = "mk2-ui/1.0"

    def _send_json(self, code: int, obj: Any) -> None:
        data = json.dumps(obj, sort_keys=True).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _send_text(self, code: int, text: str, content_type: str = "text/plain; charset=utf-8") -> None:
        data = text.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _require_token(self) -> bool:
        token = self.headers.get("x-mk2-token")
        ui: Mk2UI = self.server.ui  # type: ignore[attr-defined]
        if check_token(ui.token, token):
            return True
        self._send_json(HTTPStatus.UNAUTHORIZED, {"error": "unauthorized", "message": "Missing/invalid x-mk2-token."})
        return False

    def _read_json_body(self, max_bytes: int = 65536) -> dict[str, Any]:
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except Exception:
            length = 0
        if length <= 0 or length > max_bytes:
            return {}
        raw = self.rfile.read(length).decode("utf-8", errors="replace")
        try:
            return json.loads(raw)
        except Exception:
            return {}

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/" or self.path == "/ui":
            self.send_response(HTTPStatus.FOUND)
            self.send_header("Location", "/ui/")
            self.end_headers()
            return

        if self.path.startswith("/ui/"):
            rel = self.path[len("/ui/") :]
            if rel == "" or rel == "/":
                rel = "index.html"
            rel = rel.lstrip("/")
            target = UI_ROOT / rel
            if not target.resolve().as_posix().startswith(UI_ROOT.resolve().as_posix()):
                self._send_text(HTTPStatus.BAD_REQUEST, "bad path")
                return
            if not target.exists() or not target.is_file():
                self._send_text(HTTPStatus.NOT_FOUND, "not found")
                return
            ctype = "text/plain; charset=utf-8"
            if target.suffix == ".html":
                ctype = "text/html; charset=utf-8"
            elif target.suffix == ".js":
                ctype = "application/javascript; charset=utf-8"
            elif target.suffix == ".css":
                ctype = "text/css; charset=utf-8"
            self._send_text(HTTPStatus.OK, target.read_text(encoding="utf-8"), content_type=ctype)
            return

        if self.path == "/api/status":
            if not self._require_token():
                return
            ui: Mk2UI = self.server.ui  # type: ignore[attr-defined]
            self._send_json(HTTPStatus.OK, ui.status())
            return

        self._send_text(HTTPStatus.NOT_FOUND, "not found")

    def do_POST(self) -> None:  # noqa: N802
        if not self.path.startswith("/api/"):
            self._send_text(HTTPStatus.NOT_FOUND, "not found")
            return
        if not self._require_token():
            return

        ui: Mk2UI = self.server.ui  # type: ignore[attr-defined]
        body = self._read_json_body()
        actor_id = str(body.get("actorId", "")).strip()
        confirm = str(body.get("confirm", "")).strip()
        require_payload = bool(body.get("requirePayload", False))

        request_id = str(uuid.uuid4())

        def require_confirm() -> None:
            if not actor_id:
                raise SystemExit("Fail-closed: actorId required.")
            expected = f"APPLY {actor_id}"
            if confirm != expected:
                raise SystemExit(f"Fail-closed: confirmation must equal '{expected}'.")

        try:
            if self.path == "/api/run/gate":
                if not actor_id:
                    raise SystemExit("Fail-closed: actorId required.")
                result = ui.run_gate(actor_id=actor_id, request_id=request_id)
                self._send_json(HTTPStatus.OK, {"requestId": request_id, **result})
                return

            if self.path == "/api/run/momentum":
                require_confirm()
                result = ui.run_momentum(actor_id=actor_id, request_id=request_id, require_payload=require_payload)
                self._send_json(HTTPStatus.OK, {"requestId": request_id, **result})
                return

            if self.path == "/api/run/bastion-secondary":
                require_confirm()
                result = ui.run_bastion_secondary(actor_id=actor_id, request_id=request_id)
                self._send_json(HTTPStatus.OK, {"requestId": request_id, **result})
                return

            self._send_text(HTTPStatus.NOT_FOUND, "not found")
        except SystemExit as e:
            self._send_json(HTTPStatus.BAD_REQUEST, {"error": "fail_closed", "message": str(e)})


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=43119)
    ap.add_argument("--repo", default=str(REPO_ROOT))
    args = ap.parse_args()

    token = os.environ.get("MK2_UI_TOKEN", "").strip()
    if not token:
        raise SystemExit("MK2_UI_TOKEN is required (local-only access token). Set it in your environment and retry.")

    repo = Path(args.repo).resolve()
    if not (repo / "tools" / "ci_gate.py").exists():
        raise SystemExit(f"Repo root does not look like yggdrasil-alteration-program-mk2: {repo}")

    host = args.host
    port = find_free_port(host, args.port)

    ui = Mk2UI(repo_root=repo, token=token)
    server = ThreadingHTTPServer((host, port), Handler)
    server.ui = ui  # type: ignore[attr-defined]

    append_audit(
        repo,
        {
            "event": "ui_server_start",
            "at": utc_now_z(),
            "host": host,
            "port": port,
            "repoRoot": str(repo),
            "git": git_info(repo),
        },
    )

    print(f"Mk2 UI listening on http://{host}:{port}/ui/ (token required)")
    server.serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
