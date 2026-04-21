/**
 * TicketQuery -> JQL translator.
 *
 * Jira Query Language is close to SQL's WHERE clause. We translate the
 * structured bits of `TicketQuery` into JQL predicates joined with AND, and
 * append the free-text `text` as a raw predicate so callers can write arbitrary
 * JQL if they need a field we do not model yet.
 *
 * Value quoting: JQL single-quotes string literals and doubles single quotes
 * within them. Lists use `in (a, b, c)`.
 */

import type { TicketQuery, TicketStatusCategory, TicketType } from "../../types.js";

// Map our coarse categories to Jira's internal `statusCategory` keys.
const STATUS_CATEGORY_TO_JQL: Record<TicketStatusCategory, string> = {
  todo: "new",
  in_progress: "indeterminate",
  done: "done",
  // Jira has no native "cancelled" category -- resolution-based tickets map
  // onto the `done` category, so we filter by resolution name instead.
  cancelled: "done",
};

// Map our ticket types onto Jira's issuetype names. Jira installations can
// rename these (e.g. "Story" -> "User Story"), so callers that need custom
// types should hit the raw `text` path with an explicit `issuetype = ...`.
const TYPE_TO_JIRA: Record<TicketType, string | null> = {
  epic: "Epic",
  story: "Story",
  task: "Task",
  bug: "Bug",
  sub_task: "Sub-task",
  incident: "Incident",
  other: null,
};

function quote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function list(values: string[]): string {
  return `(${values.map(quote).join(", ")})`;
}

/**
 * Translate `TicketQuery` into a JQL string. Returns "" when the query is
 * effectively empty -- callers append `ORDER BY updated DESC` themselves if
 * they want deterministic pagination.
 */
export function queryToJql(query: TicketQuery): string {
  const clauses: string[] = [];

  if (query.text && query.text.trim().length > 0) {
    clauses.push(`(${query.text.trim()})`);
  }

  if (query.statusCategories?.length) {
    const keys = Array.from(new Set(query.statusCategories.map((c) => STATUS_CATEGORY_TO_JQL[c]).filter(Boolean)));
    if (keys.length) clauses.push(`statusCategory in ${list(keys)}`);
  }

  if (query.assigneeIds?.length) {
    clauses.push(`assignee in ${list(query.assigneeIds)}`);
  }

  if (query.reporterIds?.length) {
    clauses.push(`reporter in ${list(query.reporterIds)}`);
  }

  if (query.labels?.length) {
    clauses.push(`labels in ${list(query.labels)}`);
  }

  if (query.types?.length) {
    const names = query.types.map((t) => TYPE_TO_JIRA[t]).filter((x): x is string => !!x);
    if (names.length) clauses.push(`issuetype in ${list(names)}`);
  }

  if (query.parentId) {
    clauses.push(`parent = ${quote(query.parentId)}`);
  }

  if (query.updatedSince) {
    // JQL accepts ISO-8601 dates inside quotes; use `updated >=`.
    clauses.push(`updated >= ${quote(query.updatedSince)}`);
  }

  return clauses.join(" AND ");
}
