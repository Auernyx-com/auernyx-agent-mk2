#!/usr/bin/env python3
"""
tools/ci_gate_test.py

Independent-audit finding (2026-09-07, round 8, critical, found via SQUAD's
independent audit of this same pattern -- see SQUAD#69):
ci_gate.py's validate_auth_record() only ever checked that an authorization
record's OWN fields were well-formed (authorizedBy is an allowlisted login,
authorizedAt is a valid non-future date, reason is non-empty) -- it never
verified the record was actually produced by the real auto-authorize job
rather than hand-written by whoever opened the PR. Reproduced directly
before this fix: a record with every field individually valid, committed
as part of an attacker's own PR (no real review, no real approval, zero
involvement from the allowlisted person), passed every check with no
exception -- a complete bypass of the entire allowlist-authorization model
this gate exists to enforce.

Fixed by requiring the commit that introduced the record file to match a
SHA the workflow's auto-authorize job vouches for via the
MK2_RECORD_COMMIT_SHA environment variable -- populated only when that
job's own live, this-run GitHub API-based is_allowed check was true (see
.github/workflows/mk2-alteration-gate.yml's "Determine trusted record
commit" step). An attacker's own PR-branch commit can claim any git
author/committer identity it wants (that metadata is trivially spoofable
locally) but cannot inject a value into another job's GitHub Actions
output.

Note: this repo's test suite (npm test) is TypeScript/node:test only --
ci_gate.py had no test coverage of any kind before this file, and nothing
in ci-tests.yml currently runs Python tests. This file is runnable
standalone (`python3 tools/ci_gate_test.py` or `python3 -m unittest
tools.ci_gate_test` from the repo root) but is NOT yet wired into CI --
that's a pre-existing gap in this repo, out of scope for this fix.

Builds an isolated temp git repository (never the real mk2 checkout) and
monkeypatches ci_gate's module-level GIT_ROOT/ALLOWLIST_PATH to point at
it, so it can commit both legitimate and forged records without ever
touching real repo history.
"""
from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "tools"))

import ci_gate  # noqa: E402


def _git(repo: Path, *args: str) -> str:
    result = subprocess.run(
        ["git", "-C", str(repo), *args],
        check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
    )
    return result.stdout


class _IsolatedGateRepo:
    def __enter__(self):
        self.tmpdir = tempfile.TemporaryDirectory(prefix="ci-gate-test-")
        self.root = Path(self.tmpdir.name)
        _git(self.root, "init", "-q")
        _git(self.root, "config", "user.name", "Test Author")
        _git(self.root, "config", "user.email", "test@example.com")

        records_dir = self.root / "governance/alteration-program/authorization/records"
        records_dir.mkdir(parents=True)
        (records_dir / ".gitkeep").write_text("")

        allowlist_path = self.root / "governance/alteration-program/authorization/allowlist.json"
        allowlist_path.write_text(json.dumps({"authorizedLogins": ["Ghostwolf101"]}))

        (self.root / "README.md").write_text("fixture repo\n")
        _git(self.root, "add", "-A")
        _git(self.root, "commit", "-q", "-m", "initial")

        self._patches = [
            patch.object(ci_gate, "GIT_ROOT", self.root),
            patch.object(ci_gate, "ALLOWLIST_PATH", allowlist_path),
        ]
        for p in self._patches:
            p.start()
        return self

    def __exit__(self, *exc):
        for p in self._patches:
            p.stop()
        self.tmpdir.cleanup()

    def commit_record(self, filename: str, record: dict, *, as_bot: bool) -> str:
        path = self.root / "governance/alteration-program/authorization/records" / filename
        path.write_text(json.dumps(record))
        _git(self.root, "add", str(path))
        author = (
            "github-actions[bot] <41898282+github-actions[bot]@users.noreply.github.com>"
            if as_bot else "Test Author <test@example.com>"
        )
        name, email = author.split(" <")
        email = email.rstrip(">")
        _git(self.root, "-c", f"user.name={name}", "-c", f"user.email={email}",
             "commit", "-q", "-m", f"chore: add {filename}", f"--author={author}")
        return _git(self.root, "log", "-1", "--format=%H", "--", str(path)).strip()

    def relpath(self, filename: str) -> str:
        return f"governance/alteration-program/authorization/records/{filename}"


VALID_RECORD = {
    "authorizedBy": "Ghostwolf101",
    "authorizedAt": "2026-09-07",
    "reason": "PR #1: a real, legitimate change",
}


class ForgedRecordIsRejectedTest(unittest.TestCase):
    def test_no_trusted_sha_env_var_is_rejected(self):
        with _IsolatedGateRepo() as repo:
            repo.commit_record("2026-09-07-pr-1.json", VALID_RECORD, as_bot=False)
            with patch.dict("os.environ", {}, clear=False):
                import os
                os.environ.pop("MK2_RECORD_COMMIT_SHA", None)
                with self.assertRaises(SystemExit):
                    ci_gate.validate_auth_record(repo.relpath("2026-09-07-pr-1.json"))

    def test_forged_record_even_with_bot_authored_git_identity_is_rejected(self):
        with _IsolatedGateRepo() as repo:
            repo.commit_record("2026-09-07-pr-1.json", VALID_RECORD, as_bot=True)
            with patch.dict("os.environ", {}, clear=False):
                import os
                os.environ.pop("MK2_RECORD_COMMIT_SHA", None)
                with self.assertRaises(SystemExit):
                    ci_gate.validate_auth_record(repo.relpath("2026-09-07-pr-1.json"))

    def test_fabricated_mismatched_sha_is_rejected(self):
        with _IsolatedGateRepo() as repo:
            repo.commit_record("2026-09-07-pr-1.json", VALID_RECORD, as_bot=False)
            with patch.dict("os.environ", {"MK2_RECORD_COMMIT_SHA": "f" * 40}):
                with self.assertRaises(SystemExit):
                    ci_gate.validate_auth_record(repo.relpath("2026-09-07-pr-1.json"))


class LegitimateRecordStillAcceptedTest(unittest.TestCase):
    def test_matching_trusted_sha_is_accepted(self):
        with _IsolatedGateRepo() as repo:
            real_sha = repo.commit_record("2026-09-07-pr-1.json", VALID_RECORD, as_bot=True)
            with patch.dict("os.environ", {"MK2_RECORD_COMMIT_SHA": real_sha}):
                try:
                    ci_gate.validate_auth_record(repo.relpath("2026-09-07-pr-1.json"))
                except SystemExit as e:
                    self.fail(f"legitimate record was rejected: {e}")

    def test_still_rejects_a_record_with_a_non_allowlisted_login_even_with_matching_sha(self):
        with _IsolatedGateRepo() as repo:
            bad_record = {**VALID_RECORD, "authorizedBy": "not-on-the-allowlist"}
            real_sha = repo.commit_record("2026-09-07-pr-1.json", bad_record, as_bot=True)
            with patch.dict("os.environ", {"MK2_RECORD_COMMIT_SHA": real_sha}):
                with self.assertRaises(SystemExit):
                    ci_gate.validate_auth_record(repo.relpath("2026-09-07-pr-1.json"))


if __name__ == "__main__":
    unittest.main()
