import assert from "node:assert/strict";
import test from "node:test";
import * as path from "path";

// Rules for Dependabot PRs (.github/scripts/avrs-dependabot.js), shared by the
// gate workflow, tools/backfill-dependabot-records.js and these tests. The
// API is mocked; the same module was also run against live GitHub before this change merged.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const rules = require(path.join(__dirname, "..", "..", ".github", "scripts", "avrs-dependabot.js"));

const ALLOW = ["Ghostwolf101"];
const DEP = "dependabot[bot]";
const MERGE_SHA = "a".repeat(40);

type Fixture = {
  pr?: Record<string, unknown>;
  commits?: unknown[];
  files?: unknown[];
  reviews?: Array<Record<string, unknown>>;
};

function depCommit(sha = "d57acf9000000000000000000000000000000000") {
  return { sha, author: { login: DEP }, commit: { verification: { verified: true } } };
}

function review(id: number, login: string, state: string, at: string, commit = "d57acf9") {
  return { id, user: { login }, state, submitted_at: at, commit_id: commit };
}

function api(f: Fixture) {
  const pr = { number: 204, title: "deps: bump x from 1.0.0 to 1.0.1", user: { login: DEP }, head: { sha: "d57acf9" }, ...f.pr };
  const reviews = f.reviews ?? [];
  return {
    getPR: async () => pr,
    listCommits: async () => f.commits ?? [depCommit()],
    listFiles: async () => f.files ?? [{ filename: "package.json" }, { filename: "package-lock.json" }],
    listReviews: async () => reviews,
    getReview: async (_n: number, id: number) => reviews.find((r) => r.id === id) ?? null
  };
}

const open = (f: Fixture) => rules.checkDependabotApproval({ api: api(f), prNumber: 204, allowlist: ALLOW, today: "2026-11-27" });

test("approved Dependabot PR: allowlisted approval, own verified commits, manifests only", async () => {
  const r = await open({ reviews: [review(1, "Ghostwolf101", "APPROVED", "2026-11-27T10:00:00Z")] });
  assert.equal(r.approved, true);
  assert.equal(r.approvedBy, "Ghostwolf101");
  assert.equal(r.record.kind, "dependabot-merge");
  assert.equal(r.record.approvalReviewId, 1);
});

test("no approval yet: waits (not approved)", async () => {
  const r = await open({ reviews: [] });
  assert.equal(r.approved, false);
  assert.match(r.reason, /waiting for approval/);
});

test("approval by a login not on the allowlist does not count", async () => {
  const r = await open({ reviews: [review(1, "someone-else", "APPROVED", "2026-11-27T10:00:00Z")] });
  assert.equal(r.approved, false);
});

test("a later 'request changes' from the approver cancels the approval", async () => {
  const r = await open({
    reviews: [
      review(1, "Ghostwolf101", "APPROVED", "2026-11-27T10:00:00Z"),
      review(2, "Ghostwolf101", "CHANGES_REQUESTED", "2026-11-27T11:00:00Z")
    ]
  });
  assert.equal(r.approved, false);
  assert.match(r.reason, /requested changes/);
});

test("a later plain comment does not cancel the approval", async () => {
  const r = await open({
    reviews: [
      review(1, "Ghostwolf101", "APPROVED", "2026-11-27T10:00:00Z"),
      review(2, "Ghostwolf101", "COMMENTED", "2026-11-27T11:00:00Z")
    ]
  });
  assert.equal(r.approved, true);
});

test("any non-Dependabot commit on the branch fails, even with approval (the old #204 shape)", async () => {
  const r = await open({
    commits: [depCommit(), { sha: "1dfb695", author: { login: "Ghostwolf101" }, commit: { verification: { verified: false } } }],
    reviews: [review(1, "Ghostwolf101", "APPROVED", "2026-11-27T10:00:00Z")]
  });
  assert.equal(r.approved, false);
  assert.match(r.reason, /dependabot recreate/);
});

test("an unverified commit claiming to be Dependabot fails", async () => {
  const r = await open({
    commits: [{ sha: "bad0000", author: { login: DEP }, commit: { verification: { verified: false } } }],
    reviews: [review(1, "Ghostwolf101", "APPROVED", "2026-11-27T10:00:00Z")]
  });
  assert.equal(r.approved, false);
});

test("a file other than package.json/package-lock.json fails", async () => {
  const r = await open({
    files: [{ filename: "package.json" }, { filename: ".github/workflows/x.yml" }],
    reviews: [review(1, "Ghostwolf101", "APPROVED", "2026-11-27T10:00:00Z")]
  });
  assert.equal(r.approved, false);
  assert.match(r.reason, /x\.yml/);
});

test("a PR not opened by Dependabot never takes this path", async () => {
  const r = await open({ pr: { user: { login: "Ghostwolf101" } }, reviews: [review(1, "Ghostwolf101", "APPROVED", "2026-11-27T10:00:00Z")] });
  assert.equal(r.approved, false);
});

// ── after-merge records ─────────────────────────────────────────────────────

const merged = { merged_at: "2026-11-27T12:00:00Z", merge_commit_sha: MERGE_SHA };
const approvedBeforeMerge = [review(7, "Ghostwolf101", "APPROVED", "2026-11-27T10:00:00Z")];

async function built(f: Fixture = {}) {
  return rules.buildBackfillRecord({ api: api({ pr: merged, reviews: approvedBeforeMerge, ...f }), prNumber: 204, allowlist: ALLOW, today: "2026-11-28" });
}

test("backfill record is built from GitHub facts and verifies", async () => {
  const b = await built();
  assert.equal(b.ok, true);
  assert.equal(b.record.mergeCommit, MERGE_SHA);
  assert.equal(b.record.approvalReviewId, 7);
  assert.equal(b.record.authorizedBy, "Ghostwolf101");
  const v = await rules.verifyBackfillRecord({ api: api({ pr: merged, reviews: approvedBeforeMerge }), record: b.record, allowlist: ALLOW });
  assert.deepEqual(v, { ok: true });
});

test("backfill refuses an unmerged PR", async () => {
  const b = await built({ pr: { merged_at: null, merge_commit_sha: null } });
  assert.equal(b.ok, false);
});

test("backfill refuses a PR merged with no approval before the merge", async () => {
  const b = await built({ reviews: [review(7, "Ghostwolf101", "APPROVED", "2026-11-27T13:00:00Z")] });
  assert.equal(b.ok, false);
});

for (const [field, value] of [
  ["mergeCommit", "b".repeat(40)],
  ["change", "deps: bump something-else"],
  ["approvedCommit", "0000000"]
] as const) {
  test(`an edited backfill record (${field}) fails verification`, async () => {
    const b = await built();
    const forged = { ...b.record, [field]: value };
    const v = await rules.verifyBackfillRecord({ api: api({ pr: merged, reviews: approvedBeforeMerge }), record: forged, allowlist: ALLOW });
    assert.equal(v.ok, false);
  });
}

test("a backfill record naming a review that isn't an approval fails", async () => {
  const reviews = [...approvedBeforeMerge, review(8, "Ghostwolf101", "COMMENTED", "2026-11-27T09:00:00Z")];
  const b = await built({ reviews });
  const forged = { ...b.record, approvalReviewId: 8 };
  const v = await rules.verifyBackfillRecord({ api: api({ pr: merged, reviews }), record: forged, allowlist: ALLOW });
  assert.equal(v.ok, false);
});

test("a backfill record naming someone else as approver fails", async () => {
  const b = await built();
  const forged = { ...b.record, approvedBy: "someone-else" };
  const v = await rules.verifyBackfillRecord({ api: api({ pr: merged, reviews: approvedBeforeMerge }), record: forged, allowlist: ALLOW });
  assert.equal(v.ok, false);
});
