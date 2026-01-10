import crypto from "crypto";
import fs from "fs";
import path from "path";
import { Plan, PlanStep } from "./planner.js";
import { PolicySnapshot, PolicyVerdict } from "./policy.js";

export type Receipt = {
  receiptVersion: string;
  createdAt: string;
  planId: string;
  stepId: string;
  tool: string;
  effect: string;
  policySnapshot: PolicySnapshot;
  verdict: PolicyVerdict;
  inputDigest: string;
  outputDigest?: string;
  status: "REFUSED" | "EXECUTED";
};

export type LedgerEvent = {
  ts: string;
  type: "RECEIPT";
  prevHash: string | null;
  hash: string;
  receiptPath: string;
  receiptDigest: string;
};

export type ReceiptPaths = {
  root: string;        // e.g. <workspace>/.mk2
  receiptsDir: string; // <root>/receipts
  ledgerDir: string;   // <root>/ledger
  ledgerFile: string;  // <ledgerDir>/events.ndjson
};

export function defaultPaths(workspaceRoot: string): ReceiptPaths {
  const root = path.join(workspaceRoot, ".mk2");
  const receiptsDir = path.join(root, "receipts");
  const ledgerDir = path.join(root, "ledger");
  const ledgerFile = path.join(ledgerDir, "events.ndjson");
  return { root, receiptsDir, ledgerDir, ledgerFile };
}

function sha256(data: string | Buffer): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function ensureDirs(p: ReceiptPaths) {
  for (const d of [p.root, p.receiptsDir, p.ledgerDir]) {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  }
  // make ledger file if missing
  if (!fs.existsSync(p.ledgerFile)) fs.writeFileSync(p.ledgerFile, "", "utf8");
}

function readLastLedgerEvent(ledgerFile: string): LedgerEvent | null {
  const content = fs.readFileSync(ledgerFile, "utf8").trim();
  if (!content) return null;
  const lines = content.split("\n");
  const last = lines[lines.length - 1];
  try {
    return JSON.parse(last) as LedgerEvent;
  } catch {
    return null;
  }
}

function appendLedgerEvent(ledgerFile: string, event: LedgerEvent) {
  fs.appendFileSync(ledgerFile, JSON.stringify(event) + "\n", "utf8");
}

export function makeInputDigest(plan: Plan, step: PlanStep): string {
  return sha256(JSON.stringify({ planId: plan.planId, stepId: step.id, tool: step.tool, args: step.args }));
}

export function writeReceiptAndLedger(
  workspaceRoot: string,
  plan: Plan,
  step: PlanStep,
  snapshot: PolicySnapshot,
  verdict: PolicyVerdict,
  status: "REFUSED" | "EXECUTED",
  output?: unknown,
): { receiptPath: string; receiptDigest: string; ledgerHash: string } {
  const p = defaultPaths(workspaceRoot);
  ensureDirs(p);

  const createdAt = new Date().toISOString();
  const inputDigest = makeInputDigest(plan, step);

  const receipt: Receipt = {
    receiptVersion: "0.1.0",
    createdAt,
    planId: plan.planId,
    stepId: step.id,
    tool: step.tool,
    effect: step.effect,
    policySnapshot: snapshot,
    verdict,
    inputDigest,
    outputDigest: output === undefined ? undefined : sha256(JSON.stringify(output)),
    status,
  };

  const receiptJson = JSON.stringify(receipt, null, 2);
  const receiptDigest = sha256(receiptJson);

  const receiptFileName = `${plan.planId}__${step.id}__${createdAt.replace(/[:.]/g, "-")}.json`;
  const receiptPath = path.join(p.receiptsDir, receiptFileName);
  fs.writeFileSync(receiptPath, receiptJson, "utf8");

  const last = readLastLedgerEvent(p.ledgerFile);
  const prevHash = last?.hash ?? null;

  const eventCore = {
    ts: createdAt,
    type: "RECEIPT" as const,
    prevHash,
    receiptPath: path.relative(workspaceRoot, receiptPath).replace(/\\/g, "/"),
    receiptDigest,
  };

  const hash = sha256(JSON.stringify(eventCore));
  const event: LedgerEvent = { ...eventCore, hash };

  appendLedgerEvent(p.ledgerFile, event);

  return { receiptPath, receiptDigest, ledgerHash: hash };
}
