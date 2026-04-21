/**
 * TicketQuery -> GitHub search query string.
 *
 * GitHub's `/search/issues` endpoint uses a Google-like qualifier syntax:
 *   `bug label:frontend state:open assignee:alice updated:>=2024-01-01`.
 *
 * We flatten our structured query to a single `q` string, appending the
 * free-text fragment verbatim. Status categories collapse onto GitHub's
 * `state` qualifier (`open|closed`) plus `reason:`. We do NOT translate
 * reporter -> author (GitHub's qualifier is `author`); we translate it.
 */

import type { TicketQuery, TicketStatusCategory } from "../../types.js";

/**
 * Build a `q=` string from a TicketQuery. Optionally scope to a repo.
 * Caller must URL-encode the result before appending to a URL.
 */
export function buildSearchQuery(q: TicketQuery, scope?: { owner: string; repo: string }): string {
  const parts: string[] = ["type:issue"];
  if (scope) parts.push(`repo:${scope.owner}/${scope.repo}`);

  if (q.text && q.text.trim()) parts.push(q.text.trim());

  if (q.statusCategories?.length) {
    const state = mapStates(q.statusCategories);
    if (state.size === 1) parts.push(`state:${[...state][0]}`);
    // If both open and closed are requested, omit state: qualifier entirely.
    const reasons = mapReasons(q.statusCategories);
    for (const r of reasons) parts.push(`reason:${r}`);
  }

  for (const id of q.assigneeIds ?? []) parts.push(`assignee:${id}`);
  for (const id of q.reporterIds ?? []) parts.push(`author:${id}`);
  for (const l of q.labels ?? []) parts.push(`label:${quoteIfNeeded(l)}`);
  if (q.parentId) parts.push(`parent:${q.parentId}`); // preview; harmless if unsupported.
  if (q.updatedSince) parts.push(`updated:>=${q.updatedSince.slice(0, 10)}`);

  return parts.join(" ");
}

function mapStates(cats: TicketStatusCategory[]): Set<"open" | "closed"> {
  const out = new Set<"open" | "closed">();
  for (const c of cats) {
    if (c === "todo" || c === "in_progress") out.add("open");
    if (c === "done" || c === "cancelled") out.add("closed");
  }
  return out;
}

function mapReasons(cats: TicketStatusCategory[]): string[] {
  const reasons: string[] = [];
  if (cats.includes("cancelled")) reasons.push("not_planned");
  if (cats.includes("done")) reasons.push("completed");
  return reasons;
}

function quoteIfNeeded(label: string): string {
  return /\s/.test(label) ? `"${label}"` : label;
}
