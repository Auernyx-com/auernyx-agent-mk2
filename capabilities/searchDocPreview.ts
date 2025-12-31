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

function computeUpdate(beforeLines: string[], action: SearchDocAction, docPath: string, title?: string): { afterLines: string[]; added: string[]; removed: string[] } {
    const header = "# Search Index";
    const normalizedBefore = beforeLines.map((l) => (l ?? "").trimEnd());
    const hasHeader = normalizedBefore.some((l) => l.trim() === header);
    const base = normalizedBefore.filter((l) => l.length > 0);
    const current = hasHeader ? base : [header, "", ...base];

    const existingIdx = current.findIndex((l) => l.trimStart().startsWith(`- ${docPath}`));
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
    const actionRaw = asObj ? String(asObj.action ?? "") : "";
    const docPathRaw = asObj ? String(asObj.docPath ?? "") : "";
    const titleRaw = asObj && typeof asObj.title === "string" ? asObj.title : undefined;

    const action = (actionRaw === "add" || actionRaw === "remove") ? (actionRaw as SearchDocAction) : "add";
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
