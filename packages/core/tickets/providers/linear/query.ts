/**
 * TicketQuery -> Linear `IssueFilter` input.
 *
 * Linear's filter grammar is a nested object. Each scalar field accepts
 * comparators (`eq`, `in`, `gte`, ...). We only need a small subset.
 */

import type { TicketQuery, TicketStatusCategory } from "../../types.js";

type StateType = "triage" | "backlog" | "unstarted" | "started" | "completed" | "canceled";

const CATEGORY_STATE_TYPES: Record<TicketStatusCategory, StateType[]> = {
  todo: ["triage", "backlog", "unstarted"],
  in_progress: ["started"],
  done: ["completed"],
  cancelled: ["canceled"],
};

export interface LinearFilterBuildResult {
  filter: Record<string, unknown>;
  first: number;
}

export function buildIssueFilter(q: TicketQuery): LinearFilterBuildResult {
  const filter: Record<string, unknown> = {};

  if (q.statusCategories?.length) {
    const types = new Set<StateType>();
    for (const c of q.statusCategories) for (const t of CATEGORY_STATE_TYPES[c]) types.add(t);
    filter.state = { type: { in: [...types] } };
  }
  if (q.assigneeIds?.length) filter.assignee = { id: { in: q.assigneeIds } };
  if (q.reporterIds?.length) filter.creator = { id: { in: q.reporterIds } };
  if (q.labels?.length) filter.labels = { some: { name: { in: q.labels } } };
  if (q.parentId) filter.parent = { id: { eq: q.parentId } };
  if (q.updatedSince) filter.updatedAt = { gte: q.updatedSince };
  if (q.text?.trim()) {
    // Linear's `searchableContent.contains` supports full-text on title/body.
    filter.searchableContent = { contains: q.text.trim() };
  }

  return { filter, first: Math.min(q.limit ?? 50, 250) };
}
