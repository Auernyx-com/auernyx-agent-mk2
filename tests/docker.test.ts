import assert from "node:assert/strict";
import test from "node:test";
import { docker } from "../capabilities/docker";
import { GovernanceRefusalError } from "../core/governanceRefusal";

// docker is a declared-but-unconnected branch attachment point (per
// AUERNYX_AGENT_MK2_SUMMARY.md: "docker — Docker environment branch,
// currently declared but unconnected"). It must always refuse explicitly
// rather than silently no-op or pretend to succeed.

test("docker always refuses with BRANCH_NOT_CONNECTED, never silently succeeds", async () => {
  await assert.rejects(
    () => docker({ repoRoot: "/fake", sessionId: "s1" } as any),
    (err: unknown) => err instanceof GovernanceRefusalError && err.refusal.refusalReason === "BRANCH_NOT_CONNECTED"
  );
});
