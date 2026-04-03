/**
 * Conductor learning system.
 *
 * Tracks recurring patterns observed during orchestration.
 * Learnings with recurrence >= 3 are auto-promoted to policy.
 *
 * File format (LEARNINGS.md):
 *   ## <title>
 *   **Recurrence:** <N>
 *   **Last seen:** <ISO date>
 *   <description>
 *
 * File format (POLICY.md):
 *   ## <title>
 *   **Promoted from learnings on:** <ISO date>
 *   <description>
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";

export interface Learning {
  title: string;
  description: string;
  recurrence: number;
  lastSeen: string;  // ISO date
}

export interface Policy {
  title: string;
  description: string;
  promotedOn: string;  // ISO date
}

const PROMOTION_THRESHOLD = 3;

// ── Parsing ─────────────────────────────────────────────────────────────

function parseLearnings(content: string): Learning[] {
  const learnings: Learning[] = [];
  const sections = content.split(/^## /m).slice(1);  // Split on ## headers, skip preamble

  for (const section of sections) {
    const lines = section.trim().split("\n");
    const title = lines[0]?.trim() ?? "";
    let recurrence = 1;
    let lastSeen = new Date().toISOString();
    const descLines: string[] = [];

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      const recMatch = line.match(/^\*\*Recurrence:\*\*\s*(\d+)/);
      const dateMatch = line.match(/^\*\*Last seen:\*\*\s*(.+)/);
      if (recMatch) { recurrence = parseInt(recMatch[1], 10); }
      else if (dateMatch) { lastSeen = dateMatch[1].trim(); }
      else { descLines.push(line); }
    }

    if (title) {
      learnings.push({ title, description: descLines.join("\n").trim(), recurrence, lastSeen });
    }
  }

  return learnings;
}

function serializeLearnings(learnings: Learning[]): string {
  let out = "# Conductor Learnings\n\nPatterns observed during orchestration. Auto-promoted to POLICY.md at recurrence >= 3.\n\n";
  for (const l of learnings) {
    out += `## ${l.title}\n**Recurrence:** ${l.recurrence}\n**Last seen:** ${l.lastSeen}\n${l.description}\n\n`;
  }
  return out;
}

function parsePolicies(content: string): Policy[] {
  const policies: Policy[] = [];
  const sections = content.split(/^## /m).slice(1);

  for (const section of sections) {
    const lines = section.trim().split("\n");
    const title = lines[0]?.trim() ?? "";
    let promotedOn = "";
    const descLines: string[] = [];

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      const promoMatch = line.match(/^\*\*Promoted from learnings on:\*\*\s*(.+)/);
      if (promoMatch) { promotedOn = promoMatch[1].trim(); }
      else { descLines.push(line); }
    }

    if (title) {
      policies.push({ title, description: descLines.join("\n").trim(), promotedOn });
    }
  }

  return policies;
}

function serializePolicies(policies: Policy[]): string {
  let out = "# Conductor Policy\n\nRules promoted from learnings. These guide conductor behavior.\n\n";
  for (const p of policies) {
    out += `## ${p.title}\n**Promoted from learnings on:** ${p.promotedOn}\n${p.description}\n\n`;
  }
  return out;
}

// ── Public API ──────────────────────────────────────────────────────────

/** Record or increment a learning. Returns the updated learning and whether it was promoted. */
export function recordLearning(dir: string, title: string, description: string): { learning: Learning; promoted: boolean } {
  mkdirSync(dir, { recursive: true });

  const learningsPath = join(dir, "LEARNINGS.md");
  const policyPath = join(dir, "POLICY.md");

  // Load existing
  const learnings = existsSync(learningsPath) ? parseLearnings(readFileSync(learningsPath, "utf-8")) : [];
  const policies = existsSync(policyPath) ? parsePolicies(readFileSync(policyPath, "utf-8")) : [];

  // Find or create learning
  const existing = learnings.find(l => l.title === title);
  const now = new Date().toISOString();

  if (existing) {
    existing.recurrence += 1;
    existing.lastSeen = now;
    if (description) existing.description = description;
  } else {
    learnings.push({ title, description, recurrence: 1, lastSeen: now });
  }

  const learning = existing ?? learnings[learnings.length - 1];
  let promoted = false;

  // Check for promotion
  if (learning.recurrence >= PROMOTION_THRESHOLD) {
    // Add to policy if not already there
    if (!policies.find(p => p.title === title)) {
      policies.push({ title: learning.title, description: learning.description, promotedOn: now });
      promoted = true;
    }
    // Remove from learnings
    const idx = learnings.indexOf(learning);
    if (idx >= 0) learnings.splice(idx, 1);
  }

  // Write back
  writeFileSync(learningsPath, serializeLearnings(learnings));
  writeFileSync(policyPath, serializePolicies(policies));

  return { learning, promoted };
}

/** Get all current learnings. */
export function getLearnings(dir: string): Learning[] {
  const path = join(dir, "LEARNINGS.md");
  if (!existsSync(path)) return [];
  return parseLearnings(readFileSync(path, "utf-8"));
}

/** Get all current policies. */
export function getPolicies(dir: string): Policy[] {
  const path = join(dir, "POLICY.md");
  if (!existsSync(path)) return [];
  return parsePolicies(readFileSync(path, "utf-8"));
}

/** Get the conductor learnings directory. */
export function conductorLearningsDir(arkDir: string): string {
  return join(arkDir, "conductor");
}
