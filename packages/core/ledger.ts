/**
 * Task/Progress Ledger — structured tracking for conductor orchestration.
 * Maintains facts, hypotheses, plan, and progress with stall detection.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { ARK_DIR } from "./paths.js";

export interface LedgerEntry {
  id: string;
  type: "fact" | "hypothesis" | "plan_step" | "progress" | "stall";
  content: string;
  status?: "pending" | "in_progress" | "completed" | "stalled";
  sessionId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Ledger {
  conductorId: string;
  entries: LedgerEntry[];
  lastActivity: string;
  stallCount: number;
}

function ledgerPath(conductorId: string): string {
  return join(ARK_DIR(), "conductor", conductorId, "ledger.json");
}

export function loadLedger(conductorId: string): Ledger {
  const path = ledgerPath(conductorId);
  if (existsSync(path)) {
    try { return JSON.parse(readFileSync(path, "utf-8")); }
    catch { /* fall through */ }
  }
  return { conductorId, entries: [], lastActivity: new Date().toISOString(), stallCount: 0 };
}

export function saveLedger(ledger: Ledger): void {
  const dir = join(ARK_DIR(), "conductor", ledger.conductorId);
  mkdirSync(dir, { recursive: true });
  ledger.lastActivity = new Date().toISOString();
  writeFileSync(ledgerPath(ledger.conductorId), JSON.stringify(ledger, null, 2));
}

export function addEntry(conductorId: string, type: LedgerEntry["type"], content: string, sessionId?: string): LedgerEntry {
  const ledger = loadLedger(conductorId);
  const entry: LedgerEntry = {
    id: `le-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    type,
    content,
    status: type === "plan_step" ? "pending" : undefined,
    sessionId,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  ledger.entries.push(entry);
  saveLedger(ledger);
  return entry;
}

export function updateEntry(conductorId: string, entryId: string, updates: Partial<LedgerEntry>): void {
  const ledger = loadLedger(conductorId);
  const entry = ledger.entries.find(e => e.id === entryId);
  if (entry) {
    Object.assign(entry, updates, { updatedAt: new Date().toISOString() });
    saveLedger(ledger);
  }
}

/** Detect stalls — no progress entries in the last N minutes. */
export function detectStall(conductorId: string, thresholdMinutes: number = 10): boolean {
  const ledger = loadLedger(conductorId);
  const progressEntries = ledger.entries.filter(e => e.type === "progress");
  if (progressEntries.length === 0) return false;

  const lastProgress = progressEntries[progressEntries.length - 1];
  const elapsed = Date.now() - new Date(lastProgress.createdAt).getTime();
  const stalled = elapsed > thresholdMinutes * 60 * 1000;

  if (stalled && ledger.stallCount === 0) {
    // Mutate and save in one step to avoid addEntry overwriting our stallCount bump
    ledger.stallCount++;
    ledger.entries.push({
      id: `le-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      type: "stall",
      content: `No progress for ${thresholdMinutes} minutes`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    saveLedger(ledger);
  }

  return stalled;
}

/** Get a summary of the ledger for injection into conductor prompt. */
export function formatLedgerForPrompt(conductorId: string): string {
  const ledger = loadLedger(conductorId);
  if (ledger.entries.length === 0) return "";

  const facts = ledger.entries.filter(e => e.type === "fact").map(e => `- ${e.content}`);
  const plan = ledger.entries.filter(e => e.type === "plan_step").map(e => `- [${e.status}] ${e.content}`);
  const recent = ledger.entries.slice(-5).map(e => `- [${e.type}] ${e.content}`);

  let prompt = "\n## Task Ledger\n";
  if (facts.length) prompt += `### Facts\n${facts.join("\n")}\n`;
  if (plan.length) prompt += `### Plan\n${plan.join("\n")}\n`;
  if (recent.length) prompt += `### Recent Activity\n${recent.join("\n")}\n`;
  if (ledger.stallCount > 0) prompt += `\n⚠ Stall detected (${ledger.stallCount}x). Consider changing strategy.\n`;

  return prompt;
}
