/**
 * Generic TicketProvider framework -- domain types.
 *
 * Ark talks to many issue trackers (Jira, GitHub Issues, Linear, Bitbucket,
 * Shortcut, ClickUp, Asana, PagerDuty). Rather than hard-coding each provider
 * into flows and agents, every provider ships as a `TicketProvider` that
 * normalises its native payloads into the shapes declared in this file.
 *
 * The framework itself is intentionally thin: types + a registry + a rich-text
 * pipeline. Per-provider adapters live elsewhere (one issue per provider).
 *
 * Shape decisions that may need revisiting (flag them in a follow-up issue):
 *
 *   - Comments are currently flat (each `NormalizedComment.parentId` can
 *     reference another comment, so threads are *representable* but not
 *     required). GitHub review threads + Linear reactions push against this;
 *     if we need full conversation trees we should add a `children: string[]`
 *     mirror on the comment shape.
 *   - `NormalizedTicketEvent.changes` carries pre/post values per changed
 *     field, but the `ticket` on the event is always a full snapshot. This is
 *     the simplest contract for consumers but it does mean webhook-derived
 *     events pay a normalisation cost even when callers only want the diff.
 *     If that becomes a hot path we can split into "event" (diff only) and
 *     "event-with-snapshot" types.
 *   - `raw` escape hatches are typed as `unknown`. Providers are expected to
 *     carry their native payload through verbatim so power users can drop
 *     down when a field they need has not been promoted into the normalised
 *     shape yet.
 */

import type { Mdx } from "./richtext/mdx.js";

// ── Provider identity ──────────────────────────────────────────────────────

/**
 * All ticket providers Ark knows about. "other" is deliberately present so
 * adapters for private / bespoke trackers can register without us shipping an
 * enum bump. The registry indexes by the string value, not the union members.
 */
export type TicketProviderKind = "jira" | "github" | "linear" | "bitbucket" | "other";

// ── Rich-text ───────────────────────────────────────────────────────────────

/**
 * Unified rich-text representation. MDX is the canonical form -- every
 * provider converts its native markup (ADF / GFM / ProseMirror / ...) into
 * `RichText` before handing it to Ark, and Ark converts back to the native
 * form before writing.
 */
export type RichText = Mdx;

// ── People ──────────────────────────────────────────────────────────────────

export interface NormalizedUser {
  /** Provider-native user id (account id, login, uuid, ...). */
  id: string;
  /** Email if the provider exposes it and it is non-empty. */
  email: string | null;
  /** Display name. Falls back to login/email if the provider has none. */
  name: string;
  /** Avatar URL if available. */
  avatarUrl: string | null;
  /** The provider this user was resolved from. */
  provider: TicketProviderKind;
  /** Provider-native payload, escape hatch. */
  raw: unknown;
}

// ── Status ──────────────────────────────────────────────────────────────────

/**
 * Coarse bucket for UI filters / automation rules. Providers map their native
 * status taxonomy onto these four categories; `key`/`label` preserve the
 * provider-native values.
 */
export type TicketStatusCategory = "todo" | "in_progress" | "done" | "cancelled";

export interface NormalizedStatus {
  /** Provider-native status key (id, slug, ...). */
  key: string;
  /** Human-readable label. */
  label: string;
  category: TicketStatusCategory;
}

// ── Type / priority ─────────────────────────────────────────────────────────

/**
 * Coarse bucket for ticket type. `"other"` is the escape hatch for providers
 * that have first-class types we do not model (e.g. Asana "milestone").
 */
export type TicketType = "epic" | "story" | "task" | "bug" | "sub_task" | "incident" | "other";

// ── Ticket ──────────────────────────────────────────────────────────────────

export interface NormalizedTicket {
  provider: TicketProviderKind;
  /** Provider-native id (the thing used in REST URLs). */
  id: string;
  /** Display key (`"PROJ-123"`, `"#42"`, `"ENG-7"`). */
  key: string;
  /** Canonical web URL. */
  url: string;
  title: string;
  /** Rich-text body in MDX form. Always non-null -- use an empty root for blank. */
  body: RichText;
  status: NormalizedStatus;
  type: TicketType;
  assignee: NormalizedUser | null;
  reporter: NormalizedUser;
  /** Provider-native priority name, or null if the provider has no concept. */
  priority: string | null;
  labels: string[];
  /** Parent ticket (epic, parent story, ...). */
  parentId: string | null;
  /** Sub-ticket / child ids. Providers that do not expose this cheaply may leave it empty. */
  children: string[];
  createdAt: string;
  updatedAt: string;
  tenantId: string;
  /** Provider-native payload, escape hatch. */
  raw: unknown;
}

// ── Comments & activity ─────────────────────────────────────────────────────

export interface NormalizedComment {
  /** Provider-native comment id. */
  id: string;
  /** Ticket the comment belongs to. */
  ticketId: string;
  body: RichText;
  author: NormalizedUser;
  createdAt: string;
  updatedAt: string;
  /**
   * Parent comment id if this is a threaded reply. Providers without native
   * threading must leave this null.
   */
  parentId: string | null;
  /** Provider-native payload. */
  raw: unknown;
}

/**
 * Activity-log / history entry (status transitions, field edits, ...). Not a
 * comment. `changes` describes the field diff using the provider-native field
 * name as the key and pre/post values.
 */
export interface NormalizedActivity {
  id: string;
  ticketId: string;
  actor: NormalizedUser;
  /** Free-form activity kind -- providers may add their own (e.g. "linked"). */
  kind:
    | "transitioned"
    | "assigned"
    | "unassigned"
    | "labeled"
    | "unlabeled"
    | "commented"
    | "field_changed"
    | "linked"
    | "unlinked"
    | "other";
  /** Field-level diff. Empty for events that carry no structured change. */
  changes: Record<string, { old: unknown; new: unknown }>;
  at: string;
  raw: unknown;
}

// ── Events (webhook-normalised) ─────────────────────────────────────────────

/**
 * Output of `TicketProvider.normalizeWebhook`. Carries a full ticket snapshot
 * because consumers (triggers, dispatchers) overwhelmingly want to read "the
 * current state of the ticket" rather than reconstruct it from a diff. For
 * high-frequency providers we may revisit with a diff-only flavour.
 */
export interface NormalizedTicketEvent {
  kind: "created" | "updated" | "commented" | "transitioned" | "assigned" | "deleted";
  ticket: NormalizedTicket;
  changes?: Record<string, { old: unknown; new: unknown }>;
  actor: NormalizedUser;
  at: string;
  tenantId: string;
}

// ── Query / patch ──────────────────────────────────────────────────────────

/**
 * Generic search query. Providers translate `text` into JQL / GH search / ...,
 * and filter in-engine on the structured fields. `cursor` is opaque.
 */
export interface TicketQuery {
  /** Free-text search string (JQL, GH syntax, ... depending on provider). */
  text?: string;
  /** Restrict to these status categories. */
  statusCategories?: TicketStatusCategory[];
  /** Restrict to these assignee user ids. */
  assigneeIds?: string[];
  /** Restrict to these reporter user ids. */
  reporterIds?: string[];
  /** Restrict to these labels. */
  labels?: string[];
  /** Restrict to these ticket types. */
  types?: TicketType[];
  /** Restrict to children of this parent. */
  parentId?: string;
  /** ISO 8601; include only tickets updated at-or-after. */
  updatedSince?: string;
  /** Max tickets per page -- provider may cap. */
  limit?: number;
  /** Opaque cursor from a prior `searchIssues` response. */
  cursor?: string;
}

/** Partial update -- every field is optional and null means "clear". */
export interface TicketPatch {
  title?: string;
  body?: RichText;
  assigneeId?: string | null;
  priority?: string | null;
  labels?: string[];
  parentId?: string | null;
  /** Provider-native custom fields; the adapter decides what to do with them. */
  customFields?: Record<string, unknown>;
}

// ── Credentials + context ──────────────────────────────────────────────────

/**
 * Credentials bundle. Each provider reads only the fields it needs. The
 * registry loads these from `<arkDir>/secrets.yaml` / env and scopes them by
 * tenant before handing them to a provider call.
 */
export interface TicketCredentials {
  /** OAuth access token / PAT / API key. */
  token?: string;
  /** Bearer-style header value (for providers that need a pre-formed header). */
  bearer?: string;
  /** Basic-auth username + password / token (Bitbucket, Jira Cloud). */
  username?: string;
  password?: string;
  /** Provider base URL override (Jira server / GH Enterprise / self-hosted GitLab). */
  baseUrl?: string;
  /** Webhook signing secret. */
  webhookSecret?: string;
  /** Anything else the provider wants to carry in (raw env block, oauth refresh, ...). */
  extra?: Record<string, unknown>;
}

export interface TicketContext {
  /** Tenant the call is scoped to. Providers MUST NOT leak across tenants. */
  tenantId: string;
  /** Resolved credentials for this tenant+provider pair. */
  credentials: TicketCredentials;
  /**
   * Master kill switch for write ops. When false, `postComment` / `updateIssue`
   * / `transition` / label mutations MUST throw `TicketWriteDisabledError`.
   * Lets us ship read-only by default and gate writes behind an explicit
   * tenant flag.
   */
  writeEnabled: boolean;
}

// ── The provider interface ─────────────────────────────────────────────────

export interface TicketProvider {
  /** Provider identity -- matches the value on `NormalizedTicket.provider`. */
  kind: TicketProviderKind;

  // Read
  getIssue(id: string, ctx: TicketContext): Promise<NormalizedTicket | null>;
  searchIssues(query: TicketQuery, ctx: TicketContext): Promise<{ tickets: NormalizedTicket[]; cursor?: string }>;
  listComments(id: string, ctx: TicketContext): Promise<NormalizedComment[]>;
  listActivity(id: string, ctx: TicketContext): Promise<NormalizedActivity[]>;

  // Write -- every implementation MUST check ctx.writeEnabled
  postComment(id: string, body: RichText, ctx: TicketContext): Promise<NormalizedComment>;
  updateIssue(id: string, patch: TicketPatch, ctx: TicketContext): Promise<NormalizedTicket>;
  transitionStatus(id: string, target: string, ctx: TicketContext): Promise<NormalizedTicket>;
  addLabel(id: string, label: string, ctx: TicketContext): Promise<void>;
  removeLabel(id: string, label: string, ctx: TicketContext): Promise<void>;

  // Webhook inbound
  normalizeWebhook(payload: unknown, headers: Record<string, string>, ctx: TicketContext): NormalizedTicketEvent | null;
  verifySignature(headers: Record<string, string>, body: string, ctx: TicketContext): boolean;

  // Health
  testConnection(ctx: TicketContext): Promise<{ ok: boolean; error?: string }>;
}

// ── Errors ──────────────────────────────────────────────────────────────────

/**
 * Thrown by provider write ops when `TicketContext.writeEnabled` is false.
 * Callers should treat this as an expected, tenant-policy error, not a bug.
 */
export class TicketWriteDisabledError extends Error {
  constructor(
    public readonly provider: TicketProviderKind,
    public readonly op: string,
  ) {
    super(`Ticket write disabled for provider=${provider} op=${op}`);
    this.name = "TicketWriteDisabledError";
  }
}

/**
 * Thrown when a provider receives a ticket id / key it does not recognise.
 * Distinct from `getIssue` returning null (which means "valid id, no match").
 */
export class TicketNotFoundError extends Error {
  constructor(
    public readonly provider: TicketProviderKind,
    public readonly id: string,
  ) {
    super(`Ticket not found: provider=${provider} id=${id}`);
    this.name = "TicketNotFoundError";
  }
}
