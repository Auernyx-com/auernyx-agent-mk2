// AVRS rules for Dependabot PRs (2026-11-27). One module, used by:
//   - mk2-alteration-gate.yml `dependabot-approval` job (is this PR approved?)
//   - mk2-alteration-gate.yml `auto-authorize` job (are backfill records true?)
//   - tools/backfill-dependabot-records.js (write the record after a merge)
//   - tests/avrsDependabot.test.ts
//
// Why Dependabot PRs are different: nothing but Dependabot may push to its
// branch. Any other push (a record commit, an empty commit) makes GitHub skip
// checks on that head AND makes Dependabot stop managing the PR, so it never
// rebases or closes it when a newer version supersedes it. So the
// authorization for a Dependabot PR is a live allowlisted APPROVAL, checked
// here; the record file is filed right after the merge (backfill) and the
// gate blocks every other PR until it is.
//
// `api` is an adapter so the same rules run against Octokit (workflow), the
// gh CLI (local tool) and mocks (tests):
//   getPR(n) listCommits(n) listFiles(n) listReviews(n) getReview(n, id)
// Each returns plain GitHub REST JSON (lists fully paginated).

"use strict";

const DEPENDABOT = "dependabot[bot]";
const MANIFEST_FILES = ["package.json", "package-lock.json"];
const RECORD_DIR = "governance/alteration-program/authorization/records";
const BACKFILL_NAME_RE = /^(\d{4}-\d{2}-\d{2})-dependabot-pr-(\d+)\.json$/;

// Latest non-comment review per user, in submission order.
function latestReviewByUser(reviews) {
  const latest = new Map();
  const ordered = [...reviews].sort((a, b) => String(a.submitted_at).localeCompare(String(b.submitted_at)));
  for (const r of ordered) {
    if (!r || !r.user || r.state === "COMMENTED" || r.state === "PENDING") continue;
    latest.set(r.user.login, r);
  }
  return latest;
}

// Checks that hold for a Dependabot PR whether open or merged: authored by
// Dependabot, every commit Dependabot's own and GitHub-verified, and nothing
// changed but the npm manifests.
async function checkDependabotContents(api, prNumber, pr) {
  if (!pr || !pr.user || pr.user.login !== DEPENDABOT) {
    return { ok: false, reason: `PR #${prNumber} was not opened by ${DEPENDABOT}` };
  }
  const commits = await api.listCommits(prNumber);
  if (!commits.length) return { ok: false, reason: `PR #${prNumber} has no commits` };
  for (const c of commits) {
    const login = c.author && c.author.login;
    const verified = c.commit && c.commit.verification && c.commit.verification.verified === true;
    if (login !== DEPENDABOT || !verified) {
      return {
        ok: false,
        reason: `commit ${String(c.sha).slice(0, 7)} on PR #${prNumber} is not a verified ${DEPENDABOT} commit (author=${login}, verified=${verified}). Only Dependabot may push to its branch; comment "@dependabot recreate" to rebuild it clean.`
      };
    }
  }
  const files = await api.listFiles(prNumber);
  const extra = files.map((f) => f.filename).filter((f) => !MANIFEST_FILES.includes(f));
  if (extra.length) {
    return { ok: false, reason: `PR #${prNumber} changes files other than ${MANIFEST_FILES.join(", ")}: ${extra.join(", ")}` };
  }
  return { ok: true };
}

// Is this open Dependabot PR authorized? Authorization = an allowlisted
// login's latest review is APPROVED, and no allowlisted login's latest review
// is CHANGES_REQUESTED. Bound to the PR (one specific version bump), so a
// Dependabot rebase keeps it; any non-Dependabot commit fails it.
async function checkDependabotApproval({ api, prNumber, allowlist, today }) {
  const pr = await api.getPR(prNumber);
  const contents = await checkDependabotContents(api, prNumber, pr);
  if (!contents.ok) return { approved: false, reason: contents.reason };

  const latest = latestReviewByUser(await api.listReviews(prNumber));
  const allowed = [...latest.values()].filter((r) => allowlist.includes(r.user.login));
  const blocked = allowed.find((r) => r.state === "CHANGES_REQUESTED");
  if (blocked) {
    return { approved: false, reason: `${blocked.user.login} requested changes on PR #${prNumber}` };
  }
  const approval = allowed.filter((r) => r.state === "APPROVED").pop();
  if (!approval) {
    return { approved: false, reason: `waiting for approval: no allowlisted login (${allowlist.join(", ")}) has approved PR #${prNumber}` };
  }

  const record = {
    governance_record: `${today}-dependabot-pr-${prNumber}`,
    kind: "dependabot-merge",
    pullRequest: prNumber,
    change: pr.title,
    approvedBy: approval.user.login,
    approvedAt: String(approval.submitted_at).slice(0, 10),
    approvalReviewId: approval.id,
    approvedCommit: approval.commit_id,
    headCommit: pr.head && pr.head.sha
  };
  return { approved: true, approvedBy: approval.user.login, reason: `approved by ${approval.user.login} (review ${approval.id})`, record };
}

// Build the after-merge record for a merged Dependabot PR from GitHub facts.
// Picks the latest allowlisted APPROVED review submitted before the merge.
async function buildBackfillRecord({ api, prNumber, allowlist, today }) {
  const pr = await api.getPR(prNumber);
  if (!pr.merged_at || !pr.merge_commit_sha) return { ok: false, reason: `PR #${prNumber} is not merged` };
  const contents = await checkDependabotContents(api, prNumber, pr);
  if (!contents.ok) return { ok: false, reason: contents.reason };

  const reviews = (await api.listReviews(prNumber))
    .filter((r) => r.state === "APPROVED" && r.user && allowlist.includes(r.user.login))
    .filter((r) => String(r.submitted_at) <= String(pr.merged_at))
    .sort((a, b) => String(a.submitted_at).localeCompare(String(b.submitted_at)));
  const approval = reviews.pop();
  if (!approval) return { ok: false, reason: `PR #${prNumber} was merged with no allowlisted approval before the merge` };

  return {
    ok: true,
    record: {
      governance_record: `${today}-dependabot-pr-${prNumber}`,
      kind: "dependabot-merge",
      pullRequest: prNumber,
      change: pr.title,
      approvedBy: approval.user.login,
      approvedAt: String(approval.submitted_at).slice(0, 10),
      approvalReviewId: approval.id,
      approvedCommit: approval.commit_id,
      mergeCommit: pr.merge_commit_sha,
      mergedAt: pr.merged_at,
      authorizedBy: approval.user.login,
      authorizedAt: today,
      reason: `Dependabot PR #${prNumber} merged after approval by ${approval.user.login}: ${pr.title}`
    }
  };
}

// Is this backfill record true? Re-derives every fact from GitHub; any
// mismatch (edited, invented, wrong PR, approval after merge) fails.
async function verifyBackfillRecord({ api, record, allowlist }) {
  if (!record || record.kind !== "dependabot-merge") return { ok: false, reason: "not a dependabot-merge record" };
  const n = record.pullRequest;
  if (!Number.isInteger(n)) return { ok: false, reason: "pullRequest must be an integer" };
  const expected = await buildBackfillRecord({ api, prNumber: n, allowlist, today: record.authorizedAt });
  if (!expected.ok) return { ok: false, reason: expected.reason };

  const review = await api.getReview(n, record.approvalReviewId);
  if (!review || review.state !== "APPROVED") return { ok: false, reason: `review ${record.approvalReviewId} on PR #${n} is not an approval` };
  if (!review.user || review.user.login !== record.approvedBy || !allowlist.includes(record.approvedBy)) {
    return { ok: false, reason: `review ${record.approvalReviewId} was not submitted by allowlisted ${record.approvedBy}` };
  }
  if (String(review.submitted_at) > String(expected.record.mergedAt)) {
    return { ok: false, reason: `review ${record.approvalReviewId} was submitted after PR #${n} merged` };
  }
  for (const k of ["change", "mergeCommit", "mergedAt", "approvedCommit"]) {
    const want = k === "approvedCommit" ? review.commit_id : expected.record[k];
    if (record[k] !== want) return { ok: false, reason: `${k} in record does not match GitHub for PR #${n}` };
  }
  return { ok: true };
}

// Octokit adapter for actions/github-script.
function octokitApi(github, owner, repo) {
  return {
    getPR: async (n) => (await github.rest.pulls.get({ owner, repo, pull_number: n })).data,
    listCommits: (n) => github.paginate(github.rest.pulls.listCommits, { owner, repo, pull_number: n, per_page: 100 }),
    listFiles: (n) => github.paginate(github.rest.pulls.listFiles, { owner, repo, pull_number: n, per_page: 100 }),
    listReviews: (n) => github.paginate(github.rest.pulls.listReviews, { owner, repo, pull_number: n, per_page: 100 }),
    getReview: async (n, id) => (await github.rest.pulls.getReview({ owner, repo, pull_number: n, review_id: id })).data
  };
}

module.exports = {
  DEPENDABOT,
  MANIFEST_FILES,
  RECORD_DIR,
  BACKFILL_NAME_RE,
  latestReviewByUser,
  checkDependabotContents,
  checkDependabotApproval,
  buildBackfillRecord,
  verifyBackfillRecord,
  octokitApi
};
