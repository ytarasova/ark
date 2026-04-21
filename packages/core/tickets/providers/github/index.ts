/**
 * GitHub Issues TicketProvider implementation.
 *
 * Auth: PAT / installation token / OAuth bearer -- any Bearer-style token on
 * credentials.token or credentials.bearer.
 *
 * Reference format: "owner/repo#N" (e.g. "anthropic/ark#42"). Search supports
 * scoping via the ref-free form; omit the repo qualifier for org-wide search.
 *
 * Body format: Markdown on the wire, MDX inside Ark. We use GFM round-trip
 * converters from richtext/markdown.ts.
 *
 * Rate limits: primary limit via X-RateLimit-*, secondary via 403+retry-after,
 * both handled inside GithubClient.
 */

import { mdxToMarkdown } from "../../richtext/markdown.js";
import {
  TicketWriteDisabledError,
  type NormalizedActivity,
  type NormalizedComment,
  type NormalizedTicket,
  type NormalizedTicketEvent,
  type RichText,
  type TicketContext,
  type TicketPatch,
  type TicketProvider,
  type TicketQuery,
} from "../../types.js";
import { GithubClient } from "./client.js";
import {
  normalizeComment,
  normalizeIssue,
  normalizeUser,
  parseRef,
  type GhComment,
  type GhIssue,
  type GhUser,
} from "./normalize.js";
import { buildSearchQuery } from "./query.js";
import { normalizeWebhook, verifySignature } from "./webhook.js";

export interface GithubProviderOptions {
  /** Inject a pre-built client -- test hook. */
  clientFactory?: (ctx: TicketContext) => GithubClient;
}

export class GithubProvider implements TicketProvider {
  kind = "github" as const;

  private readonly clientFactory: (ctx: TicketContext) => GithubClient;

  constructor(opts: GithubProviderOptions = {}) {
    this.clientFactory = opts.clientFactory ?? ((ctx) => new GithubClient({ credentials: ctx.credentials }));
  }

  async getIssue(ref: string, ctx: TicketContext): Promise<NormalizedTicket | null> {
    const { owner, repo, number } = parseRef(ref);
    const client = this.clientFactory(ctx);
    const res = await client.get<GhIssue | null>(`/repos/${owner}/${repo}/issues/${number}`);
    if (res.status === 404 || !res.data) return null;
    return normalizeIssue(res.data, ctx.tenantId);
  }

  async searchIssues(
    query: TicketQuery,
    ctx: TicketContext,
  ): Promise<{ tickets: NormalizedTicket[]; cursor?: string }> {
    const client = this.clientFactory(ctx);
    const qStr = encodeURIComponent(buildSearchQuery(query));
    const limit = query.limit ?? 30;
    const url = query.cursor ?? `/search/issues?q=${qStr}&per_page=${limit}`;
    interface SearchResp {
      items: GhIssue[];
    }
    const res = await client.get<SearchResp>(url);
    const tickets = (res.data.items ?? []).map((i) => normalizeIssue(i, ctx.tenantId));
    return { tickets, cursor: res.nextCursor ?? undefined };
  }

  async listComments(ref: string, ctx: TicketContext): Promise<NormalizedComment[]> {
    const { owner, repo, number } = parseRef(ref);
    const client = this.clientFactory(ctx);
    const items = await client.paginate<GhComment>(`/repos/${owner}/${repo}/issues/${number}/comments`);
    return items.map((c) => normalizeComment(c, ref));
  }

  async listActivity(ref: string, ctx: TicketContext): Promise<NormalizedActivity[]> {
    const { owner, repo, number } = parseRef(ref);
    const client = this.clientFactory(ctx);
    interface GhEvent {
      id: number;
      event: string;
      actor: GhUser | null;
      created_at: string;
      label?: { name: string };
      assignee?: GhUser;
    }
    const events = await client.paginate<GhEvent>(`/repos/${owner}/${repo}/issues/${number}/events`);
    return events.map((e) => {
      const kind: NormalizedActivity["kind"] = mapEventKind(e.event);
      const changes: Record<string, { old: unknown; new: unknown }> = {};
      if (e.label) changes.label = { old: null, new: e.label.name };
      if (e.assignee) changes.assignee = { old: null, new: e.assignee.login };
      return {
        id: String(e.id),
        ticketId: ref,
        actor: normalizeUser(e.actor ?? undefined),
        kind,
        changes,
        at: e.created_at,
        raw: e,
      };
    });
  }

  async postComment(ref: string, body: RichText, ctx: TicketContext): Promise<NormalizedComment> {
    if (!ctx.writeEnabled) throw new TicketWriteDisabledError("github", "postComment");
    const { owner, repo, number } = parseRef(ref);
    const client = this.clientFactory(ctx);
    const res = await client.post<GhComment>(`/repos/${owner}/${repo}/issues/${number}/comments`, {
      body: mdxToMarkdown(body),
    });
    return normalizeComment(res.data, ref);
  }

  async updateIssue(ref: string, patch: TicketPatch, ctx: TicketContext): Promise<NormalizedTicket> {
    if (!ctx.writeEnabled) throw new TicketWriteDisabledError("github", "updateIssue");
    const { owner, repo, number } = parseRef(ref);
    const client = this.clientFactory(ctx);
    const body: Record<string, unknown> = {};
    if (patch.title != null) body.title = patch.title;
    if (patch.body != null) body.body = mdxToMarkdown(patch.body);
    if (patch.labels != null) body.labels = patch.labels;
    if (patch.assigneeId !== undefined) {
      body.assignees = patch.assigneeId === null ? [] : [patch.assigneeId];
    }
    // Priority and parentId have no native GitHub representation; we silently
    // ignore them. Custom fields likewise.
    const res = await client.patch<GhIssue>(`/repos/${owner}/${repo}/issues/${number}`, body);
    return normalizeIssue(res.data, ctx.tenantId);
  }

  async transitionStatus(ref: string, target: string, ctx: TicketContext): Promise<NormalizedTicket> {
    if (!ctx.writeEnabled) throw new TicketWriteDisabledError("github", "transitionStatus");
    const { owner, repo, number } = parseRef(ref);
    const client = this.clientFactory(ctx);
    const body = mapTargetToState(target);
    const res = await client.patch<GhIssue>(`/repos/${owner}/${repo}/issues/${number}`, body);
    return normalizeIssue(res.data, ctx.tenantId);
  }

  async addLabel(ref: string, label: string, ctx: TicketContext): Promise<void> {
    if (!ctx.writeEnabled) throw new TicketWriteDisabledError("github", "addLabel");
    const { owner, repo, number } = parseRef(ref);
    const client = this.clientFactory(ctx);
    await client.post(`/repos/${owner}/${repo}/issues/${number}/labels`, { labels: [label] });
  }

  async removeLabel(ref: string, label: string, ctx: TicketContext): Promise<void> {
    if (!ctx.writeEnabled) throw new TicketWriteDisabledError("github", "removeLabel");
    const { owner, repo, number } = parseRef(ref);
    const client = this.clientFactory(ctx);
    await client.delete(`/repos/${owner}/${repo}/issues/${number}/labels/${encodeURIComponent(label)}`);
  }

  normalizeWebhook(
    payload: unknown,
    headers: Record<string, string>,
    ctx: TicketContext,
  ): NormalizedTicketEvent | null {
    return normalizeWebhook(payload, headers, ctx);
  }

  verifySignature(headers: Record<string, string>, body: string, ctx: TicketContext): boolean {
    return verifySignature(headers, body, ctx);
  }

  async testConnection(ctx: TicketContext): Promise<{ ok: boolean; error?: string }> {
    try {
      const client = this.clientFactory(ctx);
      await client.get<unknown>("/user");
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }
}

function mapTargetToState(target: string): Record<string, unknown> {
  switch (target) {
    case "todo":
    case "open":
    case "in_progress":
      return { state: "open" };
    case "done":
    case "closed":
    case "completed":
      return { state: "closed", state_reason: "completed" };
    case "cancelled":
    case "not_planned":
      return { state: "closed", state_reason: "not_planned" };
    default:
      throw new Error(`GitHub: unsupported transition target "${target}" (use todo|in_progress|done|cancelled)`);
  }
}

function mapEventKind(event: string): NormalizedActivity["kind"] {
  switch (event) {
    case "closed":
    case "reopened":
      return "transitioned";
    case "assigned":
      return "assigned";
    case "unassigned":
      return "unassigned";
    case "labeled":
      return "labeled";
    case "unlabeled":
      return "unlabeled";
    case "commented":
      return "commented";
    case "referenced":
    case "cross-referenced":
      return "linked";
    default:
      return "other";
  }
}

/** Factory helper for registry wiring. */
export function createGithubProvider(): TicketProvider {
  return new GithubProvider();
}
