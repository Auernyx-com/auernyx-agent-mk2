import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";
import { searchDocPreview } from "../capabilities/searchDocPreview";
import { searchDocApply } from "../capabilities/searchDocApply";

// First test coverage for searchDocPreview.ts / searchDocApply.ts. Found and
// fixed 3 real bugs in their identically-duplicated computeUpdate/parseInput
// logic while writing these — see the regression tests below for each,
// verified with a standalone probe before and after fixing:
//
// 1. Existing-entry matching used a string-PREFIX check
//    (`l.trimStart().startsWith(\`- ${docPath}\`)`), so adding "docs/foo.md"
//    matched (and silently replaced/deleted) an unrelated existing entry for
//    "docs/foo.md.bak" — "- docs/foo.md" is a literal prefix of
//    "- docs/foo.md.bak | Backup". The capability's own reported diff even
//    called it an "update," with no idea it had destroyed a different
//    document's entry. Fixed with an exact-match parser (entryDocPath).
// 2. The blank line separating the header from the entry list survived only
//    the very first write to a fresh docs/SEARCH.md, then silently
//    disappeared on every write after that — once the header already
//    existed, the whole document went through a blanket blank-line filter
//    with no re-insertion. Fixed by always peeling the header + its
//    separator off and rebuilding [header, "", ...entries] unconditionally.
//    fixed both this and bug 1's function in the same rewrite.
// 3. A provided-but-invalid `action` (a typo, a case mismatch like "Remove",
//    an unsupported synonym like "delete") silently fell through to the same
//    default as an *omitted* action ("add") instead of refusing — the
//    opposite of the caller's evident intent, reported back as if "add" was
//    what they'd asked for. Fixed to only default when action is omitted
//    entirely; any provided-but-wrong value now throws.
//
// Also added, alongside the fix: docPath is now rejected if it contains the
// literal " | " docPath/title separator sequence, since that ambiguity let a
// crafted (or accidentally title-like) docPath collide with a genuinely
// different, later-added docPath during the same entryDocPath parse.

function makeRepoRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mk2-searchdoc-test-"));
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "test" }));
  return dir;
}

function ctx(repoRoot: string) {
  return { repoRoot, sessionId: "test-session" } as any;
}

function searchDocPath(repoRoot: string): string {
  return path.join(repoRoot, "docs", "SEARCH.md");
}

function sha256(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex");
}

// ─── searchDocPreview: read-only, never writes ─────────────────────────────

test("searchDocPreview never writes the file, even when it would change something", async () => {
  const repoRoot = makeRepoRoot();
  const result = (await searchDocPreview(ctx(repoRoot), { action: "add", docPath: "docs/a.md" })) as any;

  assert.equal(result.mode, "dry-run");
  assert.equal(result.wouldChange, true);
  assert.equal(result.before.exists, false);
  assert.equal(fs.existsSync(searchDocPath(repoRoot)), false);
});

test("searchDocPreview reports wouldChange:false and an empty diff when the add is a true no-op", async () => {
  const repoRoot = makeRepoRoot();
  await searchDocApply(ctx(repoRoot), { action: "add", docPath: "docs/a.md" });

  const result = (await searchDocPreview(ctx(repoRoot), { action: "add", docPath: "docs/a.md" })) as any;
  assert.equal(result.wouldChange, false);
  assert.deepEqual(result.diff, { added: [], removed: [] });
});

// ─── searchDocApply: basic add/remove behavior ─────────────────────────────

test("apply add on a fresh repo creates docs/SEARCH.md with the header and the new entry", async () => {
  const repoRoot = makeRepoRoot();
  const result = (await searchDocApply(ctx(repoRoot), { action: "add", docPath: "docs/a.md", title: "Doc A" })) as any;

  assert.equal(result.wrote, true);
  assert.deepEqual(result.diff, { added: ["- docs/a.md | Doc A"], removed: [] });
  assert.equal(fs.readFileSync(searchDocPath(repoRoot), "utf8"), "# Search Index\n\n- docs/a.md | Doc A\n");
});

test("apply remove deletes an existing entry and reports it in removed", async () => {
  const repoRoot = makeRepoRoot();
  await searchDocApply(ctx(repoRoot), { action: "add", docPath: "docs/a.md" });
  const result = (await searchDocApply(ctx(repoRoot), { action: "remove", docPath: "docs/a.md" })) as any;

  assert.equal(result.wrote, true);
  assert.deepEqual(result.diff, { added: [], removed: ["- docs/a.md"] });
  assert.equal(fs.readFileSync(searchDocPath(repoRoot), "utf8"), "# Search Index\n");
});

test("apply remove of a docPath that doesn't exist is a true no-op — wrote:false, nothing on disk changes", async () => {
  const repoRoot = makeRepoRoot();
  await searchDocApply(ctx(repoRoot), { action: "add", docPath: "docs/a.md" });
  const before = fs.readFileSync(searchDocPath(repoRoot), "utf8");

  const result = (await searchDocApply(ctx(repoRoot), { action: "remove", docPath: "docs/does-not-exist.md" })) as any;
  assert.equal(result.wrote, false);
  assert.deepEqual(result.diff, { added: [], removed: [] });
  assert.equal(fs.readFileSync(searchDocPath(repoRoot), "utf8"), before);
});

test("re-adding the identical docPath+title is a true no-op — wrote:false", async () => {
  const repoRoot = makeRepoRoot();
  await searchDocApply(ctx(repoRoot), { action: "add", docPath: "docs/a.md", title: "Doc A" });
  const result = (await searchDocApply(ctx(repoRoot), { action: "add", docPath: "docs/a.md", title: "Doc A" })) as any;
  assert.equal(result.wrote, false);
});

test("adding the same docPath with a different title replaces the entry in place", async () => {
  const repoRoot = makeRepoRoot();
  await searchDocApply(ctx(repoRoot), { action: "add", docPath: "docs/a.md", title: "Old Title" });
  const result = (await searchDocApply(ctx(repoRoot), { action: "add", docPath: "docs/a.md", title: "New Title" })) as any;

  assert.deepEqual(result.diff, { added: ["- docs/a.md | New Title"], removed: ["- docs/a.md | Old Title"] });
  const content = fs.readFileSync(searchDocPath(repoRoot), "utf8");
  assert.ok(content.includes("- docs/a.md | New Title"));
  assert.ok(!content.includes("Old Title"));
  assert.equal(content.split("\n").filter((l) => l.startsWith("- docs/a.md")).length, 1);
});

// ─── Regression: bug 1, prefix-collision on existing-entry matching ────────

test("(the fix) adding docs/foo.md does not clobber an unrelated existing docs/foo.md.bak entry", async () => {
  const repoRoot = makeRepoRoot();
  await searchDocApply(ctx(repoRoot), { action: "add", docPath: "docs/foo.md.bak", title: "Backup" });
  const result = (await searchDocApply(ctx(repoRoot), { action: "add", docPath: "docs/foo.md", title: "Main" })) as any;

  assert.deepEqual(result.diff, { added: ["- docs/foo.md | Main"], removed: [] });
  const content = fs.readFileSync(searchDocPath(repoRoot), "utf8");
  assert.ok(content.includes("- docs/foo.md.bak | Backup"));
  assert.ok(content.includes("- docs/foo.md | Main"));
});

test("(the fix) removing docs/foo.md does not remove an unrelated existing docs/foo.md.bak entry", async () => {
  const repoRoot = makeRepoRoot();
  await searchDocApply(ctx(repoRoot), { action: "add", docPath: "docs/foo.md.bak", title: "Backup" });
  await searchDocApply(ctx(repoRoot), { action: "add", docPath: "docs/foo.md", title: "Main" });
  const result = (await searchDocApply(ctx(repoRoot), { action: "remove", docPath: "docs/foo.md" })) as any;

  assert.deepEqual(result.diff, { added: [], removed: ["- docs/foo.md | Main"] });
  const content = fs.readFileSync(searchDocPath(repoRoot), "utf8");
  assert.ok(content.includes("- docs/foo.md.bak | Backup"));
  assert.ok(!content.includes("- docs/foo.md | Main"));
});

// ─── Regression: bug 2, header separator blank line stability ─────────────

test("(the fix) the blank line under the header survives every write, not just the first", async () => {
  const repoRoot = makeRepoRoot();
  await searchDocApply(ctx(repoRoot), { action: "add", docPath: "docs/a.md" });
  const afterFirst = fs.readFileSync(searchDocPath(repoRoot), "utf8");
  assert.equal(afterFirst, "# Search Index\n\n- docs/a.md\n");

  await searchDocApply(ctx(repoRoot), { action: "add", docPath: "docs/b.md" });
  const afterSecond = fs.readFileSync(searchDocPath(repoRoot), "utf8");
  assert.equal(afterSecond, "# Search Index\n\n- docs/a.md\n- docs/b.md\n");

  await searchDocApply(ctx(repoRoot), { action: "add", docPath: "docs/c.md" });
  const afterThird = fs.readFileSync(searchDocPath(repoRoot), "utf8");
  assert.equal(afterThird, "# Search Index\n\n- docs/a.md\n- docs/b.md\n- docs/c.md\n");
});

test("(the fix) format is stable across a no-op write — reapplying an unchanged entry never touches the blank line or ordering", async () => {
  const repoRoot = makeRepoRoot();
  await searchDocApply(ctx(repoRoot), { action: "add", docPath: "docs/a.md" });
  await searchDocApply(ctx(repoRoot), { action: "add", docPath: "docs/b.md" });
  const before = fs.readFileSync(searchDocPath(repoRoot), "utf8");

  const result = (await searchDocApply(ctx(repoRoot), { action: "add", docPath: "docs/a.md" })) as any;
  assert.equal(result.wrote, false);
  assert.equal(fs.readFileSync(searchDocPath(repoRoot), "utf8"), before);
});

// ─── Regression: bug 3, invalid action silently defaulting to "add" ────────

test("(the fix) an omitted action still defaults to add", async () => {
  const repoRoot = makeRepoRoot();
  const result = (await searchDocApply(ctx(repoRoot), { docPath: "docs/a.md" })) as any;
  assert.equal(result.action, "add");
  assert.equal(result.wrote, true);
});

test("(the fix) a provided-but-invalid action (wrong case) throws instead of silently defaulting to add", async () => {
  const repoRoot = makeRepoRoot();
  await searchDocApply(ctx(repoRoot), { action: "add", docPath: "docs/a.md" });

  await assert.rejects(
    () => searchDocApply(ctx(repoRoot), { action: "Remove", docPath: "docs/a.md" }),
    /invalid_action/
  );
  // And nothing was silently applied as an "add" in the process.
  assert.equal(fs.readFileSync(searchDocPath(repoRoot), "utf8"), "# Search Index\n\n- docs/a.md\n");
});

test("(the fix) an unsupported synonym action ('delete') throws rather than silently adding", async () => {
  const repoRoot = makeRepoRoot();
  await assert.rejects(
    () => searchDocApply(ctx(repoRoot), { action: "delete", docPath: "docs/a.md" }),
    /invalid_action/
  );
});

// ─── docPath validation ─────────────────────────────────────────────────────

test("an empty docPath is refused", async () => {
  const repoRoot = makeRepoRoot();
  await assert.rejects(() => searchDocApply(ctx(repoRoot), { action: "add", docPath: "" }), /invalid_doc_path/);
});

test("a docPath containing '..' is refused (path traversal guard)", async () => {
  const repoRoot = makeRepoRoot();
  await assert.rejects(() => searchDocApply(ctx(repoRoot), { action: "add", docPath: "../../etc/passwd" }), /invalid_doc_path/);
});

test("(the fix) a docPath containing the docPath/title separator ' | ' is refused", async () => {
  const repoRoot = makeRepoRoot();
  await assert.rejects(
    () => searchDocApply(ctx(repoRoot), { action: "add", docPath: "docs/a.md | fake title" }),
    /invalid_doc_path/
  );
});

test("(the fix, prevented by the guard above) a docPath that would have embedded a separator can no longer collide with an unrelated later entry", async () => {
  const repoRoot = makeRepoRoot();
  await assert.rejects(() => searchDocApply(ctx(repoRoot), { action: "add", docPath: "docs/a.md | fake title" }));
  const result = (await searchDocApply(ctx(repoRoot), { action: "add", docPath: "docs/a.md", title: "Real A" })) as any;
  assert.equal(result.wrote, true);
  assert.equal(fs.readFileSync(searchDocPath(repoRoot), "utf8"), "# Search Index\n\n- docs/a.md | Real A\n");
});

// ─── Hash bookkeeping ───────────────────────────────────────────────────────

test("before/after hashes reported by apply match the actual file content before and after", async () => {
  const repoRoot = makeRepoRoot();
  const first = (await searchDocApply(ctx(repoRoot), { action: "add", docPath: "docs/a.md" })) as any;
  assert.equal(first.before.sha256, sha256(""));
  assert.equal(first.after.sha256, sha256(fs.readFileSync(searchDocPath(repoRoot), "utf8")));

  const beforeContent = fs.readFileSync(searchDocPath(repoRoot), "utf8");
  const second = (await searchDocApply(ctx(repoRoot), { action: "add", docPath: "docs/b.md" })) as any;
  assert.equal(second.before.sha256, sha256(beforeContent));
  assert.equal(second.after.sha256, sha256(fs.readFileSync(searchDocPath(repoRoot), "utf8")));
});

// ─── preview/apply consistency ──────────────────────────────────────────────
// The two capabilities duplicate computeUpdate/parseInput verbatim rather
// than sharing it — a real maintenance risk (this pass had to apply every
// fix twice, by hand, in two files) worth calling out even though it isn't a
// behavioral bug today. This test at least pins that today they still agree.

test("preview's predicted diff and hashes match what apply actually produces, for the same input against the same starting state", async () => {
  const repoRoot = makeRepoRoot();
  await searchDocApply(ctx(repoRoot), { action: "add", docPath: "docs/a.md", title: "Doc A" });

  const preview = (await searchDocPreview(ctx(repoRoot), { action: "remove", docPath: "docs/a.md" })) as any;
  const applied = (await searchDocApply(ctx(repoRoot), { action: "remove", docPath: "docs/a.md" })) as any;

  assert.deepEqual(preview.diff, applied.diff);
  assert.equal(preview.before.sha256, applied.before.sha256);
  assert.equal(preview.after.sha256, applied.after.sha256);
});
