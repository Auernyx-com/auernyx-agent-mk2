import * as vscode from "vscode";
import { createCore } from "../../core/server";
import { tryRunViaDaemon } from "../../core/daemonClient";
import { createHumanApproval } from "../../core/approvals";
import { capabilityRequiresApproval, CapabilityName } from "../../core/policy";
import { runLifecycle } from "../../core/runLifecycle";
import { isJudgmentActive } from "../../core/provenance";

function getJudgmentClipArtLines(): string[] {
    // CLIP ART DROP-IN SECTION
    // Paste ASCII art lines here later to visually enhance the Judgment banner.
    // Keep it plain text (no ANSI colors); this renders in an Output Channel.
    return [];
}

async function tryOpenJudgmentArt(repoRoot: string, channel: vscode.OutputChannel): Promise<void> {
    // IMAGE DROP-IN SECTION
    // If you want to use a real image (like the one you attached), place it at:
    //   <repoRoot>/clients/vscode/aeurnyx socal face.png
    //   <repoRoot>/clients/vscode/obsedeansjudgement.png
    // or (fallback)
    //   <repoRoot>/assets/judgment.png
    // VS Code can render PNGs directly in an editor tab.
    const candidates = [
        vscode.Uri.joinPath(vscode.Uri.file(repoRoot), "clients", "vscode", "aeurnyx socal face.png"),
        vscode.Uri.joinPath(vscode.Uri.file(repoRoot), "clients", "vscode", "obsedeansjudgement.png"),
        vscode.Uri.joinPath(vscode.Uri.file(repoRoot), "assets", "judgment.png")
    ];

    let found: vscode.Uri | null = null;
    for (const uri of candidates) {
        try {
            await vscode.workspace.fs.stat(uri);
            found = uri;
            break;
        } catch {
            // continue
        }
    }

    if (!found) {
        channel.appendLine(`(Judgment art not found. Checked: ${candidates.map((u) => u.fsPath).join(" | ")})`);
        return;
    }

    channel.appendLine(`Judgment art: ${found.fsPath}`);
    // Open the image (best-effort). This is intentionally non-blocking UX.
    await vscode.commands.executeCommand("vscode.open", found);
}

async function getApprovalFromUser(capability: string): Promise<ReturnType<typeof createHumanApproval> | null> {
    const pick = await vscode.window.showWarningMessage(
        `Approval required: ${capability}`,
        { modal: true, detail: "Auernyx will not execute changes without explicit human approval." },
        "Approve",
        "Cancel"
    );

    if (pick !== "Approve") return null;

    const reason = await vscode.window.showInputBox({
        prompt: `Reason for approving ${capability}`,
        placeHolder: "Why are you allowing this change?",
        validateInput: (v) => (v.trim().length > 0 ? null : "Reason is required")
    });

    if (!reason) return null;
    return createHumanApproval(reason.trim());
}

type RefusalLike = { code?: string; reason?: string } | undefined;

function refusalSummary(refusal: RefusalLike): { code: string; reason: string } {
    const code = String(refusal?.code ?? "refused");
    let reason = String(refusal?.reason ?? code);

    // UX: when a controlled op is routed to a read-only daemon, the backend returns write_disabled.
    // Make the reason immediately actionable and non-technical.
    if (code === "write_disabled" && (reason === code || reason.includes("write_disabled"))) {
        reason = "Controlled operation routed to read-only daemon";
    }

    return { code, reason };
}

function nextValidStateForRefusal(code: string): string {
    if (code === "obsidian_judgment") return "Monitor-only: run Scan/Memory; fix provenance or enable write to create genesis.";
    if (code === "approval_required" || code === "step_approval_required") return "Provide explicit approval (human) for the requested capability.";
    if (code === "confirm_required") return "Controlled operation: retry with confirm=APPLY.";
    if (code === "write_disabled") return "Run locally with --no-daemon or stop daemon.";
    return "Try a read-only command (Scan/Memory) or open the receipt for details.";
}

async function showRefused(
    repoRoot: string,
    channel: vscode.OutputChannel,
    refusal: RefusalLike,
    receiptDirPath?: string
): Promise<void> {
    const { code, reason } = refusalSummary(refusal);
    channel.appendLine("REFUSED");
    channel.appendLine(`Reason: ${reason}`);
    channel.appendLine(`Next valid state: ${nextValidStateForRefusal(code)}`);

    const receiptFinal = receiptDirPath
        ? vscode.Uri.joinPath(vscode.Uri.file(receiptDirPath), "final.json")
        : undefined;
    const hasFinal = receiptFinal ? await uriExists(receiptFinal) : false;

    const buttons: string[] = [];
    if (code === "obsidian_judgment") buttons.push("Run Scan (Monitor)");
    if (receiptDirPath) buttons.push(hasFinal ? "Open Receipt" : "Reveal Receipt");
    buttons.push("Dismiss");

    const picked = await vscode.window.showErrorMessage(
        "REFUSED",
        { modal: true, detail: `${code}\n${reason}\n\nNext valid state: ${nextValidStateForRefusal(code)}` },
        ...buttons
    );

    if (picked === "Run Scan (Monitor)") {
        await vscode.commands.executeCommand("auernyx.scanRepo");
        return;
    }

    if ((picked === "Open Receipt" || picked === "Reveal Receipt") && receiptDirPath) {
        if (picked === "Open Receipt" && hasFinal && receiptFinal) {
            await vscode.commands.executeCommand("vscode.open", receiptFinal);
            return;
        }
        await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(receiptDirPath));
        return;
    }

    void repoRoot;
}

async function uriExists(uri: vscode.Uri): Promise<boolean> {
    try {
        await vscode.workspace.fs.stat(uri);
        return true;
    } catch {
        return false;
    }
}

async function pickRepoRoot(): Promise<string | undefined> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) return undefined;

    // Prefer a folder that looks like the Auernyx Mk2 repo root.
    // This avoids accidentally treating a parent workspace (e.g. c:\Projects) as the repoRoot.
    for (const folder of folders) {
        const marker = vscode.Uri.joinPath(folder.uri, "config", "auernyx.config.json");
        if (await uriExists(marker)) return folder.uri.fsPath;
    }

    // Fallback to first folder if no marker is found.
    return folders[0].uri.fsPath;
}

export async function activate(context: vscode.ExtensionContext) {
    const repoRoot = await pickRepoRoot();

    if (!repoRoot) {
        vscode.window.showWarningMessage("Auernyx: No workspace open.");
        return;
    }

    const root: string = repoRoot;

    const core = createCore(root);

    const rails = vscode.window.createOutputChannel("Auernyx");
    context.subscriptions.push(rails);

    const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);

    const uiState: {
        repoRoot: string;
        status: "READY" | "RUNNING" | "REFUSED";
        lastIntent?: string;
        lastReasonCode?: string;
        lastReceiptPath?: string;
    } = {
        repoRoot: root,
        status: isJudgmentActive(root) ? "REFUSED" : "READY",
    };

    const renderStatus = () => {
        status.text = `Auernyx: ${uiState.status}`;
        status.tooltip = [
            `Where: ${uiState.repoRoot}`,
            "What: Ask Auernyx • Scan Repo • Prepare Feneris Port",
            "Why no: REFUSED is intentional; follow the Next valid state",
            uiState.lastIntent ? `Last intent: ${uiState.lastIntent}` : undefined,
            uiState.lastReasonCode ? `Last reason: ${uiState.lastReasonCode}` : undefined,
            uiState.lastReceiptPath ? `Last receipt: ${uiState.lastReceiptPath}` : undefined
        ].filter(Boolean).join("\n");
    };

    renderStatus();
    status.show();
    context.subscriptions.push(status);

    if (isJudgmentActive(root)) {
        const judgmentChannel = vscode.window.createOutputChannel("Auernyx Judgment");
        context.subscriptions.push(judgmentChannel);

        for (const line of getJudgmentClipArtLines()) judgmentChannel.appendLine(line);
        judgmentChannel.appendLine("You know what you did.");
        judgmentChannel.show(true);

        // Best-effort: show dropped-in image art if present.
        void tryOpenJudgmentArt(root, judgmentChannel);
    }

    async function runWithRails(params: {
        intent: string;
        daemonInput?: unknown;
        approval?: ReturnType<typeof createHumanApproval>;
    }): Promise<void> {
        uiState.status = "RUNNING";
        uiState.lastIntent = params.intent;
        uiState.lastReasonCode = undefined;
        uiState.lastReceiptPath = undefined;
        renderStatus();

        rails.show(true);
        rails.appendLine("Step 1: Intake");
        rails.appendLine(`Intent: ${params.intent}`);

        try {
            rails.appendLine("Step 2: Check");

            // Try daemon first.
            let daemon = await tryRunViaDaemon({ repoRoot: root }, params.intent, params.daemonInput, params.approval);
            if (daemon !== null) {
                if (!daemon.ok && daemon.error === "approval_required") {
                    uiState.status = "REFUSED";
                    uiState.lastReasonCode = "approval_required";
                    renderStatus();
                    await showRefused(root, rails, { code: "approval_required", reason: "Daemon requires approval" });
                    return;
                }
                if (!daemon.ok) {
                    uiState.status = "REFUSED";
                    uiState.lastReasonCode = String(daemon.error ?? "daemon_error");
                    renderStatus();
                    await showRefused(root, rails, { code: daemon.error ?? "daemon_error", reason: daemon.error ?? "daemon error" });
                    return;
                }

                rails.appendLine("Step 3: Receipt");
                rails.appendLine("Via: daemon");
                vscode.window.showInformationMessage(`Auernyx: Ran ${daemon.capability ?? "capability"}.`);
                uiState.status = "READY";
                renderStatus();
                return;
            }

            const capability = core.router.route({ raw: params.intent });
            rails.appendLine(`Capability: ${capability ?? "(unroutable)"}`);
            if (!capability) {
                vscode.window.showInformationMessage(`Auernyx: Unroutable intent: "${params.intent}"`);
                uiState.status = "READY";
                renderStatus();
                return;
            }

            const needsApproval = capabilityRequiresApproval(capability as CapabilityName);
            const approval = needsApproval ? await getApprovalFromUser(capability) : null;
            if (needsApproval && !approval) {
                uiState.status = "REFUSED";
                uiState.lastReasonCode = "approval_required";
                renderStatus();
                await showRefused(root, rails, { code: "approval_required", reason: "User did not approve" });
                return;
            }

            const lifecycle = await runLifecycle({
                router: core.router,
                ctx: { repoRoot: root, sessionId: core.sessionId },
                intent: params.intent,
                input: params.daemonInput,
                approval: approval ?? params.approval ?? undefined,
            });

            rails.appendLine("Step 3: Receipt");
            rails.appendLine(`Receipt: ${lifecycle.receipt?.dirPath ?? "(none)"}`);
            uiState.lastReceiptPath = lifecycle.receipt?.dirPath;

            if (!lifecycle.ok) {
                uiState.status = "REFUSED";
                uiState.lastReasonCode = String(lifecycle.refusal?.code ?? lifecycle.refusal?.reason ?? "refused");
                renderStatus();
                await showRefused(root, rails, lifecycle.refusal, lifecycle.receipt?.dirPath);
                return;
            }

            uiState.status = "READY";
            renderStatus();
            vscode.window.showInformationMessage(`Auernyx: Ran ${capability}.`);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            rails.appendLine("ERROR");
            rails.appendLine(msg);
            uiState.status = "REFUSED";
            uiState.lastReasonCode = msg;
            renderStatus();
            vscode.window.showErrorMessage(`Auernyx: ${msg}`);
        }
    }

    context.subscriptions.push(
        vscode.commands.registerCommand("auernyx.ask", async () => {
            const input = await vscode.window.showInputBox({ prompt: "Auernyx (one verb): scan | memory | baseline pre | baseline post | feneris | …" });
            if (!input) return;

            await runWithRails({ intent: input });
        }),

        vscode.commands.registerCommand("auernyx.scanRepo", async () => {
            await runWithRails({ intent: "scan" });
        }),

        vscode.commands.registerCommand("auernyx.fenerisPrep", async () => {
            await runWithRails({ intent: "feneris" });
        })
    );

    console.log("Auernyx Agent loaded.");
}

export function deactivate() {}
