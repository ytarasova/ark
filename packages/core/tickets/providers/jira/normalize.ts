/**
 * Jira REST JSON -> Normalized* shapes.
 *
 * Covers read-side normalisation for issue + comment + changelog payloads.
 * The ADF body is converted to MDX via `adfToMdx`; unknown ADF nodes land in
 * the MDX preservation escape hatch so they survive round-trips.
 *
 * Lossy conversions that do NOT round-trip 1:1 (documented, deliberate):
 *   - `resolution` is flattened into `status.category` as `done` (no
 *     separate `cancelled` category in Jira -- we currently do not inspect
 *     the resolution name to decide cancelled-vs-done).
 *   - Time-tracking fields (`timeSpent`, `timeEstimate`) are not promoted
 *     onto `NormalizedTicket`; callers can read them via `.raw`.
 *   - Custom fields other than the Epic Link (`customfield_10014`) are not
 *     promoted; callers can read them via `.raw`.
 *   - `NormalizedUser.email` is null whenever Jira privacy settings hide it.
 *   - Changelog entries with more than one `items[]` produce one
 *     NormalizedActivity with all changes merged into the same `changes` map
 *     (the `kind` is chosen from the first item).
 */

import { adfToMdx } from "../../richtext/adf.js";
import type { AdfDoc } from "../../richtext/adf.js";
import { emptyMdx } from "../../richtext/mdx.js";
import type {
  NormalizedActivity,
  NormalizedComment,
  NormalizedStatus,
  NormalizedTicket,
  NormalizedUser,
  RichText,
  TicketStatusCategory,
  TicketType,
} from "../../types.js";

// ── Raw Jira payload surface (minimal local copy) ──────────────────────────

export interface JiraUser {
  accountId?: string;
  emailAddress?: string | null;
  displayName?: string;
  avatarUrls?: Record<string, string>;
  name?: string; // DC legacy
  key?: string; // DC legacy
}

export interface JiraStatus {
  id?: string;
  name?: string;
  statusCategory?: {
    key?: string;
    name?: string;
  };
}

export interface JiraIssueFields {
  summary?: string;
  description?: AdfDoc | null;
  status?: JiraStatus;
  issuetype?: { name?: string };
  assignee?: JiraUser | null;
  reporter?: JiraUser | null;
  creator?: JiraUser | null;
  priority?: { name?: string } | null;
  labels?: string[];
  parent?: { id?: string; key?: string } | null;
  created?: string;
  updated?: string;
  subtasks?: { id?: string; key?: string }[];
  // Epic Link (classic Jira Cloud customfield id).
  customfield_10014?: string | null;
  [k: string]: unknown;
}

export interface JiraIssue {
  id: string;
  key: string;
  self?: string;
  fields: JiraIssueFields;
  renderedFields?: unknown;
  changelog?: {
    histories?: JiraChangelogHistory[];
  };
}

export interface JiraChangelogHistory {
  id: string;
  author?: JiraUser;
  created: string;
  items?: JiraChangelogItem[];
}

export interface JiraChangelogItem {
  field: string;
  fieldtype?: string;
  from?: string | null;
  fromString?: string | null;
  to?: string | null;
  toString?: string | null;
}

export interface JiraComment {
  id: string;
  author?: JiraUser;
  updateAuthor?: JiraUser;
  body?: AdfDoc | string;
  created: string;
  updated: string;
}

// ── Maps ────────────────────────────────────────────────────────────────────

const STATUS_CATEGORY_MAP: Record<string, TicketStatusCategory> = {
  new: "todo",
  indeterminate: "in_progress",
  done: "done",
  undefined: "todo",
};

const TYPE_MAP: Record<string, TicketType> = {
  Epic: "epic",
  Story: "story",
  Task: "task",
  Bug: "bug",
  "Sub-task": "sub_task",
  Subtask: "sub_task",
  Incident: "incident",
};

// ── User ────────────────────────────────────────────────────────────────────

export function normalizeUser(user: JiraUser | null | undefined): NormalizedUser | null {
  if (!user) return null;
  const id = user.accountId ?? user.key ?? user.name ?? "";
  if (!id) return null;
  const email = user.emailAddress && user.emailAddress.length > 0 ? user.emailAddress : null;
  const avatarUrl = user.avatarUrls?.["48x48"] ?? user.avatarUrls?.["32x32"] ?? null;
  return {
    id,
    email,
    name: user.displayName ?? user.name ?? email ?? id,
    avatarUrl,
    provider: "jira",
    raw: user,
  };
}

/** Stand-in user used when Jira omits reporter / author (rare, but happens on deleted accounts). */
export function unknownUser(): NormalizedUser {
  return {
    id: "unknown",
    email: null,
    name: "Unknown",
    avatarUrl: null,
    provider: "jira",
    raw: null,
  };
}

// ── Status ──────────────────────────────────────────────────────────────────

function normalizeStatus(status: JiraStatus | undefined): NormalizedStatus {
  const categoryKey = status?.statusCategory?.key ?? "undefined";
  return {
    key: status?.id ?? status?.name ?? "unknown",
    label: status?.name ?? "Unknown",
    category: STATUS_CATEGORY_MAP[categoryKey] ?? "todo",
  };
}

// ── Body ────────────────────────────────────────────────────────────────────

function normalizeBody(body: AdfDoc | string | null | undefined): RichText {
  if (!body) return emptyMdx();
  if (typeof body === "string") {
    // DC / legacy installations may return plain wiki markup. We drop it into a
    // single paragraph to avoid attempting a wiki-markup parse here; round-trip
    // callers should normalise through MDX regardless.
    return {
      type: "root",
      children: [{ type: "paragraph", children: [{ type: "text", value: body }] }],
    };
  }
  if (body.type !== "doc") return emptyMdx();
  return adfToMdx(body);
}

// ── Type ────────────────────────────────────────────────────────────────────

function normalizeType(name: string | undefined): TicketType {
  if (!name) return "other";
  return TYPE_MAP[name] ?? "other";
}

// ── Ticket ──────────────────────────────────────────────────────────────────

export interface NormalizeIssueOptions {
  tenantId: string;
  /** Canonical web URL -- caller injects it so we do not hard-code the cloud path. */
  webBaseUrl?: string;
}

export function normalizeIssue(issue: JiraIssue, opts: NormalizeIssueOptions): NormalizedTicket {
  const f = issue.fields;
  const reporter = normalizeUser(f.reporter ?? f.creator) ?? unknownUser();
  const assignee = normalizeUser(f.assignee ?? null);
  const parentId = f.parent?.id ?? (f.customfield_10014 ? String(f.customfield_10014) : null);
  const children = (f.subtasks ?? []).map((s) => s.id ?? s.key ?? "").filter((x) => x.length > 0);
  const url = opts.webBaseUrl ? `${opts.webBaseUrl.replace(/\/$/, "")}/browse/${issue.key}` : (issue.self ?? "");

  return {
    provider: "jira",
    id: String(issue.id),
    key: issue.key,
    url,
    title: f.summary ?? "",
    body: normalizeBody(f.description ?? null),
    status: normalizeStatus(f.status),
    type: normalizeType(f.issuetype?.name),
    assignee,
    reporter,
    priority: f.priority?.name ?? null,
    labels: f.labels ?? [],
    parentId,
    children,
    createdAt: f.created ?? new Date(0).toISOString(),
    updatedAt: f.updated ?? f.created ?? new Date(0).toISOString(),
    tenantId: opts.tenantId,
    raw: issue,
  };
}

// ── Comment ─────────────────────────────────────────────────────────────────

export function normalizeComment(comment: JiraComment, ticketId: string): NormalizedComment {
  return {
    id: String(comment.id),
    ticketId,
    body: normalizeBody(comment.body ?? null),
    author: normalizeUser(comment.author) ?? unknownUser(),
    createdAt: comment.created,
    updatedAt: comment.updated ?? comment.created,
    parentId: null,
    raw: comment,
  };
}

// ── Activity (changelog) ────────────────────────────────────────────────────

function kindFromField(field: string): NormalizedActivity["kind"] {
  const f = field.toLowerCase();
  if (f === "status") return "transitioned";
  if (f === "assignee") return "assigned";
  if (f === "labels") return "labeled";
  if (f === "resolution") return "transitioned";
  if (f === "link") return "linked";
  return "field_changed";
}

export function normalizeChangelog(history: JiraChangelogHistory, ticketId: string): NormalizedActivity {
  const items = history.items ?? [];
  const first = items[0];
  const changes: Record<string, { old: unknown; new: unknown }> = {};
  for (const item of items) {
    changes[item.field] = {
      old: item.fromString ?? item.from ?? null,
      new: item.toString ?? item.to ?? null,
    };
  }
  return {
    id: String(history.id),
    ticketId,
    actor: normalizeUser(history.author) ?? unknownUser(),
    kind: first ? kindFromField(first.field) : "other",
    changes,
    at: history.created,
    raw: history,
  };
}
