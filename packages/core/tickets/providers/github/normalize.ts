/**
 * GitHub issue / comment / user / event payload -> Normalized shapes.
 *
 * GitHub has no first-class type concept for issues; we infer epic / story /
 * task / bug from labels. GitHub also has only two states (open, closed) plus
 * a `state_reason` disambiguator; we map to the 4-way category taxonomy.
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

export interface GhUser {
  id: number | string;
  login: string;
  name?: string | null;
  email?: string | null;
  avatar_url?: string | null;
  html_url?: string | null;
}

export interface GhLabel {
  id?: number;
  name: string;
  description?: string | null;
  color?: string | null;
}

export interface GhIssue {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: "open" | "closed";
  state_reason: "completed" | "not_planned" | "reopened" | null;
  html_url: string;
  user: GhUser;
  assignee: GhUser | null;
  assignees?: GhUser[];
  labels: Array<GhLabel | string>;
  created_at: string;
  updated_at: string;
  repository_url?: string;
  parent?: { id: number; number: number } | null;
  sub_issues?: Array<{ id: number; number: number }>;
}

export interface GhComment {
  id: number;
  body: string;
  user: GhUser;
  created_at: string;
  updated_at: string;
  issue_url?: string;
  html_url?: string;
}

/** Extract "owner/repo#N" from a GitHub issue payload. */
export function refOf(issue: GhIssue): string {
  if (issue.repository_url) {
    const m = /\/repos\/([^/]+)\/([^/]+)\b/.exec(issue.repository_url);
    if (m) return `${m[1]}/${m[2]}#${issue.number}`;
  }
  const m = /github\.com\/([^/]+)\/([^/]+)\/issues\/\d+/.exec(issue.html_url);
  if (m) return `${m[1]}/${m[2]}#${issue.number}`;
  return `#${issue.number}`;
}

/** "owner/repo#N" -> {owner, repo, number}. */
export function parseRef(ref: string): { owner: string; repo: string; number: number } {
  const m = /^([^/]+)\/([^#]+)#(\d+)$/.exec(ref);
  if (!m) throw new Error(`GitHub ref must be "owner/repo#N", got: ${ref}`);
  return { owner: m[1], repo: m[2], number: Number(m[3]) };
}

export function normalizeUser(u: GhUser | null | undefined): NormalizedUser {
  if (!u) {
    return {
      id: "ghost",
      email: null,
      name: "ghost",
      avatarUrl: null,
      provider: "github",
      raw: null,
    };
  }
  return {
    id: String(u.id ?? u.login),
    email: u.email ?? null,
    name: u.name ?? u.login,
    avatarUrl: u.avatar_url ?? null,
    provider: "github",
    raw: u,
  };
}

export function normalizeStatus(issue: GhIssue): NormalizedStatus {
  const category = statusCategory(issue);
  const label = issue.state === "open" ? "Open" : issue.state_reason === "not_planned" ? "Not planned" : "Closed";
  return {
    key: issue.state_reason ? `${issue.state}:${issue.state_reason}` : issue.state,
    label,
    category,
  };
}

function statusCategory(issue: GhIssue): TicketStatusCategory {
  if (issue.state === "closed") {
    if (issue.state_reason === "not_planned") return "cancelled";
    return "done";
  }
  if (issue.state_reason === "reopened") return "in_progress";
  return "todo";
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

export function inferType(labels: Array<GhLabel | string>): TicketType {
  for (const l of labels) {
    const name = (typeof l === "string" ? l : (l.name ?? "")).toLowerCase();
    if (TYPE_LABELS[name]) return TYPE_LABELS[name];
  }
  return "other";
}

export function labelNames(labels: Array<GhLabel | string>): string[] {
  return labels.map((l) => (typeof l === "string" ? l : l.name)).filter((n): n is string => !!n);
}

export function normalizeIssue(issue: GhIssue, tenantId: string): NormalizedTicket {
  const ref = refOf(issue);
  return {
    provider: "github",
    id: ref,
    key: `#${issue.number}`,
    url: issue.html_url,
    title: issue.title,
    body: markdownToMdx(issue.body ?? ""),
    status: normalizeStatus(issue),
    type: inferType(issue.labels ?? []),
    assignee: issue.assignee ? normalizeUser(issue.assignee) : null,
    reporter: normalizeUser(issue.user),
    priority: null,
    labels: labelNames(issue.labels ?? []),
    parentId: issue.parent ? `parent#${issue.parent.number}` : null,
    children: (issue.sub_issues ?? []).map((c) => `child#${c.number}`),
    createdAt: issue.created_at,
    updatedAt: issue.updated_at,
    tenantId,
    raw: issue,
  };
}

export function normalizeComment(comment: GhComment, ticketId: string): NormalizedComment {
  return {
    id: String(comment.id),
    ticketId,
    body: markdownToMdx(comment.body ?? ""),
    author: normalizeUser(comment.user),
    createdAt: comment.created_at,
    updatedAt: comment.updated_at,
    parentId: null,
    raw: comment,
  };
}
