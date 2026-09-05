import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import type { RouterContext } from "../core/router";

type SearchDocAction = "add" | "remove";

type SearchDocInput = {
    action: SearchDocAction;
    docPath: string;
    title?: string;
};

function sha256Hex(buf: Buffer | string): string {
    return crypto.createHash("sha256").update(buf).digest("hex");
}

function normalizeDocPath(p: string): string {
    const v = String(p ?? "").trim().replace(/\\/g, "/");
    if (!v) throw new Error("invalid_doc_path");
    if (v.includes("..")) throw new Error("invalid_doc_path");
    // " | " is the docPath/title separator entryLine renders and
    // entryDocPath parses back out. A docPath containing it literally shifts
    // where that first split lands — verified directly: adding
    // "docs/a.md | fake title" then adding the real "docs/a.md" with a title
    // collapsed both into one line, because entryDocPath's first-"| "-split
    // extracted "docs/a.md" out of the bogus entry too. Rejecting it here
    // keeps the encoding unambiguous rather than trying to make the parser
    // handle a docPath that can never be told apart from a title boundary.
    if (v.includes(" | ")) throw new Error("invalid_doc_path");
    return v;
}

function entryLine(docPath: string, title?: string): string {
    const t = typeof title === "string" ? title.trim() : "";
    return t.length > 0 ? `- ${docPath} | ${t}` : `- ${docPath}`;
}

function readLines(filePath: string): { exists: boolean; raw: string; lines: string[]; sha256: string } {
    if (!fs.existsSync(filePath)) {
        return { exists: false, raw: "", lines: [], sha256: sha256Hex("") };
    }
    const raw = fs.readFileSync(filePath, "utf8");
    const lines = raw.replace(/\r\n/g, "\n").split("\n");
    return { exists: true, raw, lines, sha256: sha256Hex(raw) };
}

function renderDoc(lines: string[]): string {
    // Normalize to \n and ensure trailing newline for stable hashing.
    const body = lines.join("\n").replace(/\r\n/g, "\n");
    return body.endsWith("\n") ? body : body + "\n";
}

// Pulls the docPath back out of a rendered entry line ("- <docPath>" or
// "- <docPath> | <title>"), so matching against an existing entry is an exact
// comparison rather than a string-prefix check. Was `l.trimStart().startsWith(
// \`- ${docPath}\`)` — a real bug, found while adding test coverage, not from
// a symptom: adding "docs/foo.md" matched (and silently replaced) an
// unrelated existing entry for "docs/foo.md.bak", because "- docs/foo.md" is
// a literal string prefix of "- docs/foo.md.bak | Backup". Verified directly
// before fixing: the capability's own reported diff even called it an
// "update" (removed the .bak entry, added the new one) — it had no idea it
// had destroyed a different document's index entry.
function entryDocPath(line: string): string | null {
    const t = line.trimStart();
    if (!t.startsWith("- ")) return null;
    const rest = t.slice(2);
    const sepIdx = rest.indexOf(" | ");
    return sepIdx === -1 ? rest : rest.slice(0, sepIdx);
}

function computeUpdate(beforeLines: string[], action: SearchDocAction, docPath: string, title?: string): { afterLines: string[]; added: string[]; removed: string[] } {
    const header = "# Search Index";
    const normalizedBefore = beforeLines.map((l) => (l ?? "").trimEnd());

    // Peel off a leading header + its one separator blank line (if present),
    // then always rebuild as [header, "", ...entries] below. Previously, once
    // the header already existed, the whole document (including that
    // separator blank line) went through a blanket blank-line filter with no
    // re-insertion — the blank line under the header quietly vanished after
    // the very first write and never came back. Verified directly: write 1
    // produced "# Search Index\n\n- a.md\n", write 2 produced
    // "# Search Index\n- a.md\n- b.md\n" — the file's own formatting drifted
    // on every edit after the first for no reason related to the edit itself.
    let body = normalizedBefore;
    if (body[0]?.trim() === header) {
        body = body.slice(1);
        if (body[0] === "") body = body.slice(1);
    }
    const base = body.filter((l) => l.length > 0);
    const current = [header, "", ...base];

    const existingIdx = current.findIndex((l) => entryDocPath(l) === docPath);
    const next = [...current];

    const removed: string[] = [];
    const added: string[] = [];

    if (action === "add") {
        const line = entryLine(docPath, title);
        if (existingIdx >= 0) {
            const prev = next[existingIdx];
            if (prev !== line) {
                removed.push(prev);
                added.push(line);
                next[existingIdx] = line;
            }
        } else {
            added.push(line);
            next.push(line);
        }
    } else {
        if (existingIdx >= 0) {
            removed.push(next[existingIdx]);
            next.splice(existingIdx, 1);
        }
    }

    return { afterLines: next, added, removed };
}

function parseInput(ctx: RouterContext, input?: unknown): SearchDocInput {
    const asObj = (input && typeof input === "object") ? (input as Record<string, unknown>) : null;
    const actionProvided = asObj ? asObj.action : undefined;
    const docPathRaw = asObj ? String(asObj.docPath ?? "") : "";
    const titleRaw = asObj && typeof asObj.title === "string" ? asObj.title : undefined;

    // A missing action defaults to "add" (ergonomic). A *provided but wrong*
    // action — a typo, a case mismatch ("Remove"), an unsupported synonym
    // ("delete") — used to silently fall through to that same "add" default
    // instead of refusing. Verified directly: action:"Remove" against an
    // existing entry returned {action:"add", wrote:false} and left the entry
    // in place — the opposite of the caller's evident intent, reported back
    // as if "add" was what they'd actually asked for. docPath already fails
    // closed on a bad value (normalizeDocPath throws); action now does too.
    let action: SearchDocAction = "add";
    if (actionProvided !== undefined) {
        if (actionProvided !== "add" && actionProvided !== "remove") {
            throw new Error(`invalid_action: expected "add" or "remove", got ${JSON.stringify(actionProvided)}`);
        }
        action = actionProvided;
    }
    const docPath = normalizeDocPath(docPathRaw);
    const title = typeof titleRaw === "string" ? titleRaw : undefined;
    void ctx;
    return { action, docPath, title };
}

export async function searchDocPreview(ctx: RouterContext, input?: unknown): Promise<unknown> {
    const parsed = parseInput(ctx, input);
    const searchPathRel = "docs/SEARCH.md";
    const searchPathAbs = path.join(ctx.repoRoot, searchPathRel);

    const before = readLines(searchPathAbs);
    const upd = computeUpdate(before.lines, parsed.action, parsed.docPath, parsed.title);
    const afterText = renderDoc(upd.afterLines);
    const afterHash = sha256Hex(afterText);

    return {
        mode: "dry-run",
        action: parsed.action,
        searchDocPath: searchPathRel,
        targetDocPath: parsed.docPath,
        title: parsed.title ?? "",
        wouldChange: before.sha256 !== afterHash,
        diff: { added: upd.added, removed: upd.removed },
        before: { exists: before.exists, sha256: before.sha256, lineCount: before.lines.length },
        after: { sha256: afterHash, lineCount: upd.afterLines.length },
        preview: {
            beforeHead: before.lines.slice(0, 40).join("\n"),
            afterHead: upd.afterLines.slice(0, 40).join("\n")
        }
    };
}
