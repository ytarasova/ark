/**
 * Bitbucket Cloud Issues -> Normalized shapes.
 *
 * Quirks:
 *   - Content is `{ type: "rendered", markup: "markdown", raw: "..." }`.
 *     We pull `raw` and run it through markdownToMdx.
 *   - Issue state enum: new | open | resolved | on hold | invalid |
 *     duplicate | wontfix | closed.
 *   - `kind` maps to TicketType: bug | enhancement | proposal | task.
 *   - Users identify by `uuid`; `account_id` is sometimes missing. We use
 *     `uuid` as the stable id and display_name as the label.
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

export interface BbUser {
  type?: string;
  uuid: string;
  username?: string;
  display_name?: string;
  account_id?: string | null;
  links?: { avatar?: { href: string } };
}

export interface BbContent {
  type?: "rendered";
  raw: string;
  markup?: string;
  html?: string | null;
}

export interface BbIssue {
  id: number;
  title: string;
  content: BbContent | null;
  state: string;
  kind?: "bug" | "enhancement" | "proposal" | "task";
  priority?: string | null;
  reporter: BbUser | null;
  assignee: BbUser | null;
  created_on: string;
  updated_on: string;
  links?: { html?: { href: string }; self?: { href: string } };
  component?: { name: string } | null;
  milestone?: { name: string } | null;
  version?: { name: string } | null;
  repository?: { full_name: string };
}

export interface BbComment {
  id: number;
  content: BbContent | null;
  user: BbUser | null;
  created_on: string;
  updated_on: string;
  links?: { html?: { href: string } };
  parent?: { id: number } | null;
}

/** ws/repo#N -> {workspace, repo, id}. */
export function parseRef(ref: string): { workspace: string; repo: string; id: number } {
  const m = /^([^/]+)\/([^#]+)#(\d+)$/.exec(ref);
  if (!m) throw new Error(`Bitbucket ref must be "workspace/repo#N", got: ${ref}`);
  return { workspace: m[1], repo: m[2], id: Number(m[3]) };
}

export function refOf(issue: BbIssue): string {
  const full = issue.repository?.full_name;
  if (full) return `${full}#${issue.id}`;
  const self = issue.links?.self?.href ?? "";
  const m = /repositories\/([^/]+)\/([^/]+)\/issues\/\d+/.exec(self);
  if (m) return `${m[1]}/${m[2]}#${issue.id}`;
  return `#${issue.id}`;
}

export function normalizeUser(u: BbUser | null | undefined): NormalizedUser {
  if (!u) {
    return { id: "ghost", email: null, name: "unknown", avatarUrl: null, provider: "bitbucket", raw: null };
  }
  return {
    id: u.uuid,
    email: null,
    name: u.display_name || u.username || u.uuid,
    avatarUrl: u.links?.avatar?.href ?? null,
    provider: "bitbucket",
    raw: u,
  };
}

export function statusCategory(state: string): TicketStatusCategory {
  switch (state) {
    case "new":
    case "on hold":
      return "todo";
    case "open":
      return "in_progress";
    case "resolved":
    case "closed":
      return "done";
    case "invalid":
    case "wontfix":
    case "duplicate":
      return "cancelled";
    default:
      return "todo";
  }
}

export function normalizeStatus(state: string): NormalizedStatus {
  return { key: state, label: titleCase(state), category: statusCategory(state) };
}

const KIND_MAP: Record<string, TicketType> = {
  bug: "bug",
  enhancement: "story",
  proposal: "story",
  task: "task",
};

export function normalizeIssue(issue: BbIssue, tenantId: string): NormalizedTicket {
  const ref = refOf(issue);
  const raw = issue.content?.raw ?? "";
  const type: TicketType = (issue.kind ? KIND_MAP[issue.kind] : undefined) ?? "other";
  const labels: string[] = [];
  if (issue.component?.name) labels.push(`component:${issue.component.name}`);
  if (issue.milestone?.name) labels.push(`milestone:${issue.milestone.name}`);
  if (issue.version?.name) labels.push(`version:${issue.version.name}`);

  return {
    provider: "bitbucket",
    id: ref,
    key: `#${issue.id}`,
    url: issue.links?.html?.href ?? "",
    title: issue.title,
    body: markdownToMdx(raw),
    status: normalizeStatus(issue.state),
    type,
    assignee: issue.assignee ? normalizeUser(issue.assignee) : null,
    reporter: normalizeUser(issue.reporter),
    priority: issue.priority ?? null,
    labels,
    parentId: null,
    children: [],
    createdAt: issue.created_on,
    updatedAt: issue.updated_on,
    tenantId,
    raw: issue,
  };
}

export function normalizeComment(comment: BbComment, ticketId: string): NormalizedComment {
  const raw = comment.content?.raw ?? "";
  return {
    id: String(comment.id),
    ticketId,
    body: markdownToMdx(raw),
    author: normalizeUser(comment.user),
    createdAt: comment.created_on,
    updatedAt: comment.updated_on,
    parentId: comment.parent ? String(comment.parent.id) : null,
    raw: comment,
  };
}

function titleCase(s: string): string {
  return s
    .split(" ")
    .map((w) => (w.length ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}
