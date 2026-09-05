import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "fs";
import { skjoldrFirewallStatus } from "../capabilities/skjoldrFirewallStatus";
import { skjoldrFirewallApplyProfile } from "../capabilities/skjoldrFirewallApplyProfile";
import { skjoldrFirewallApplyRulesetFile } from "../capabilities/skjoldrFirewallApplyRulesetFile";
import { skjoldrFirewallExportBaseline } from "../capabilities/skjoldrFirewallExportBaseline";
import { skjoldrFirewallRestoreBaseline } from "../capabilities/skjoldrFirewallRestoreBaseline";
import { skjoldrFirewallAdviseInboundRuleSets } from "../capabilities/skjoldrFirewallAdviseInboundRuleSets";
import { makeSkjoldrRepoRoot } from "./helpers/fakeSkjoldrCli";

// First test coverage for all 6 skjoldrFirewall* capability wrappers, using
// a real, directly-spawnable fake CLI (tests/helpers/fakeSkjoldrCli.ts)
// standing in for the actual Skjoldr executable — same technique already
// proven in tests/skjoldrFirewall.test.ts for the underlying core module.

function ctx(repoRoot: string) {
  return { repoRoot, sessionId: "test-session" } as any;
}

test("skjoldrFirewallStatus: reports ok when the fake CLI responds cleanly", async () => {
  const { repoRoot } = makeSkjoldrRepoRoot("mk2-skjoldr-status-");
  const result = (await skjoldrFirewallStatus(ctx(repoRoot))) as any;
  assert.equal(result.ok, true);
  assert.equal(result.enabled, true);
  assert.equal(result.available, true);
});

test("skjoldrFirewallStatus: reports disabled cleanly when the addon isn't enabled", async () => {
  const repoRoot = makeSkjoldrRepoRoot("mk2-skjoldr-status-disabled-").repoRoot;
  fs.writeFileSync(repoRoot + "/config/auernyx.config.json", JSON.stringify({ addons: { skjoldrFirewall: { enabled: false } } }));
  const result = (await skjoldrFirewallStatus(ctx(repoRoot))) as any;
  assert.equal(result.enabled, false);
  assert.equal(result.available, false);
});

test("skjoldrFirewallApplyProfile: runs export -> dry-run -> apply -> status in sequence and reports each", async () => {
  const { repoRoot } = makeSkjoldrRepoRoot("mk2-skjoldr-apply-");
  const result = (await skjoldrFirewallApplyProfile(ctx(repoRoot), { profile: "conservative" })) as any;

  assert.equal(result.ok, true);
  assert.equal(result.profile, "conservative");
  assert.equal(result.preExport.ok, true);
  assert.equal(result.dryRun.ok, true);
  assert.equal(result.applied.ok, true);
  assert.equal(result.postStatus.ok, true);
  assert.ok(result.dryRun.data.args.includes("--dry-run"));
});

test("skjoldrFirewallApplyProfile: requires a profile in the input", async () => {
  const { repoRoot } = makeSkjoldrRepoRoot("mk2-skjoldr-apply-noprofile-");
  await assert.rejects(() => skjoldrFirewallApplyProfile(ctx(repoRoot), {}), /profile is required/);
});

test("skjoldrFirewallApplyProfile: propagates a dry-run failure rather than proceeding to the real apply", async () => {
  const { repoRoot } = makeSkjoldrRepoRoot("mk2-skjoldr-apply-fail-");
  process.env.FAKE_SKJOLDR_FAIL_VERB = "apply";
  try {
    await assert.rejects(
      () => skjoldrFirewallApplyProfile(ctx(repoRoot), { profile: "fortress" }),
      /dry-run returned ok=false/
    );
  } finally {
    delete process.env.FAKE_SKJOLDR_FAIL_VERB;
  }
});

test("skjoldrFirewallApplyRulesetFile: requires the ruleset file to actually exist on disk", async () => {
  const { repoRoot } = makeSkjoldrRepoRoot("mk2-skjoldr-ruleset-missing-");
  await assert.rejects(
    () => skjoldrFirewallApplyRulesetFile(ctx(repoRoot), { rulesetPath: "/definitely/not/a/real/file.json" }),
    /Ruleset file not found/
  );
});

test("skjoldrFirewallApplyRulesetFile: applies a real, existing ruleset file end to end", async () => {
  const { repoRoot } = makeSkjoldrRepoRoot("mk2-skjoldr-ruleset-ok-");
  const rulesetPath = repoRoot + "/ruleset.json";
  fs.writeFileSync(rulesetPath, JSON.stringify({ rules: [] }));

  const result = (await skjoldrFirewallApplyRulesetFile(ctx(repoRoot), { rulesetPath })) as any;
  assert.equal(result.ok, true);
  assert.equal(result.rulesetPath, rulesetPath);
  assert.equal(result.applied.ok, true);
});

test("skjoldrFirewallExportBaseline: extracts the real snapshot path/hash and verifies the file exists", async () => {
  const { repoRoot } = makeSkjoldrRepoRoot("mk2-skjoldr-export-");
  const result = (await skjoldrFirewallExportBaseline(ctx(repoRoot))) as any;

  assert.equal(result.ok, true);
  assert.ok(fs.existsSync(result.baselineSnapshotPath));
  assert.equal(result.baselineSnapshotHash, result.computedHash);
});

test("skjoldrFirewallRestoreBaseline: requires both a snapshot path and a matching hash before restoring", async () => {
  const { repoRoot } = makeSkjoldrRepoRoot("mk2-skjoldr-restore-missing-");
  await assert.rejects(() => skjoldrFirewallRestoreBaseline(ctx(repoRoot), {}), /baselineSnapshotPath is required/);
});

test("skjoldrFirewallRestoreBaseline: refuses when the snapshot hash doesn't match the file content", async () => {
  const { repoRoot } = makeSkjoldrRepoRoot("mk2-skjoldr-restore-badhash-");
  const snapshotPath = repoRoot + "/snapshot.json";
  fs.writeFileSync(snapshotPath, "content");

  await assert.rejects(
    () =>
      skjoldrFirewallRestoreBaseline(ctx(repoRoot), {
        baselineSnapshotPath: snapshotPath,
        baselineSnapshotHash: "0".repeat(64),
      }),
    /Baseline verification failed/
  );
});

test("skjoldrFirewallRestoreBaseline: restores end to end when the snapshot hash matches", async () => {
  const { repoRoot } = makeSkjoldrRepoRoot("mk2-skjoldr-restore-ok-");
  const snapshotPath = repoRoot + "/snapshot.json";
  const content = "real snapshot content";
  fs.writeFileSync(snapshotPath, content);

  const crypto = require("crypto");
  const hash = crypto.createHash("sha256").update(content).digest("hex");

  const result = (await skjoldrFirewallRestoreBaseline(ctx(repoRoot), {
    baselineSnapshotPath: snapshotPath,
    baselineSnapshotHash: hash,
  })) as any;

  assert.equal(result.ok, true);
  assert.equal(result.restored.ok, true);
});

test("skjoldrFirewallAdviseInboundRuleSets: returns advisory recommendations without applying any changes", async () => {
  const { repoRoot } = makeSkjoldrRepoRoot("mk2-skjoldr-advise-");
  const result = (await skjoldrFirewallAdviseInboundRuleSets(ctx(repoRoot), {})) as any;

  assert.equal(result.ok, true);
  assert.ok(result.advice.length > 0);
  assert.ok(result.notes.some((n: string) => n.includes("read-only")));
});
