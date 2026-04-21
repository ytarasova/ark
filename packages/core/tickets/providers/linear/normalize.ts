/**
 * Linear -> Normalized ticket shapes.
 *
 * Linear's GraphQL API returns Markdown for issue descriptions and comment
 * bodies on read, and accepts Markdown on write. We route through
 * markdownToMdx / mdxToMarkdown and sidestep ProseMirror conversion entirely.
 *
 * Type inference: Linear has no first-class type enum, so we inspect labels
 * (case-insensitive match on epic / story / task / bug / incident / sub-task)
 * and fall back to `sub_task` when the issue has a parent.
 */

import { markdownToMdx } from "../../richtext/markdown.js";
import type {
  NormalizedComment,
  NormalizedStatus,
  NormalizedTicket,
  NormalizedUser,
  TicketStatusCategory,
  TicketType,
} from "../../types.js";

export interface LinearUser {
  id: string;
  name?: string | null;
  displayName?: string | null;
  email?: string | null;
  avatarUrl?: string | null;
}

export interface LinearState {
  id: string;
  name: string;
  /** One of: triage, backlog, unstarted, started, completed, canceled. */
  type: string;
}

export interface LinearLabel {
  id: string;
  name: string;
}

export interface LinearIssue {
  id: string;
  identifier: string; // "ENG-42"
  title: string;
  description: string | null;
  url: string;
  priority: number | null;
  priorityLabel?: string | null;
  createdAt: string;
  updatedAt: string;
  state: LinearState;
  assignee: LinearUser | null;
  creator: LinearUser | null;
  labels: { nodes: LinearLabel[] };
  parent: { id: string; identifier?: string } | null;
  children?: { nodes: Array<{ id: string; identifier?: string }> };
  team?: { id: string; key: string };
}

export interface LinearComment {
  id: string;
  body: string;
  createdAt: string;
  updatedAt: string;
  user: LinearUser | null;
  parent?: { id: string } | null;
  issue?: { id: string } | null;
}

export function normalizeUser(u: LinearUser | null | undefined): NormalizedUser {
  if (!u) {
    return { id: "ghost", email: null, name: "unknown", avatarUrl: null, provider: "linear", raw: null };
  }
  return {
    id: u.id,
    email: u.email ?? null,
    name: u.displayName || u.name || u.email || u.id,
    avatarUrl: u.avatarUrl ?? null,
    provider: "linear",
    raw: u,
  };
}

export function statusCategory(state: LinearState): TicketStatusCategory {
  switch (state.type) {
    case "triage":
    case "backlog":
    case "unstarted":
      return "todo";
    case "started":
      return "in_progress";
    case "completed":
      return "done";
    case "canceled":
      return "cancelled";
    default:
      return "todo";
  }
}

export function normalizeStatus(state: LinearState): NormalizedStatus {
  return { key: state.id, label: state.name, category: statusCategory(state) };
}

const TYPE_LABELS: Record<string, TicketType> = {
  epic: "epic",
  story: "story",
  task: "task",
  bug: "bug",
  "sub-task": "sub_task",
  subtask: "sub_task",
  incident: "incident",
};

export function inferType(issue: LinearIssue): TicketType {
  for (const l of issue.labels?.nodes ?? []) {
    const v = TYPE_LABELS[l.name.toLowerCase()];
    if (v) return v;
  }
  if (issue.parent) return "sub_task";
  return "other";
}

export function normalizeIssue(issue: LinearIssue, tenantId: string): NormalizedTicket {
  return {
    provider: "linear",
    id: issue.identifier,
    key: issue.identifier,
    url: issue.url,
    title: issue.title,
    body: markdownToMdx(issue.description ?? ""),
    status: normalizeStatus(issue.state),
    type: inferType(issue),
    assignee: issue.assignee ? normalizeUser(issue.assignee) : null,
    reporter: normalizeUser(issue.creator ?? null),
    priority: issue.priorityLabel ?? (issue.priority != null ? String(issue.priority) : null),
    labels: (issue.labels?.nodes ?? []).map((l) => l.name),
    parentId: issue.parent?.identifier ?? issue.parent?.id ?? null,
    children: (issue.children?.nodes ?? []).map((c) => c.identifier ?? c.id),
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    tenantId,
    raw: issue,
  };
}

export function normalizeComment(comment: LinearComment, ticketId: string): NormalizedComment {
  return {
    id: comment.id,
    ticketId,
    body: markdownToMdx(comment.body ?? ""),
    author: normalizeUser(comment.user),
    createdAt: comment.createdAt,
    updatedAt: comment.updatedAt,
    parentId: comment.parent?.id ?? null,
    raw: comment,
  };
}
