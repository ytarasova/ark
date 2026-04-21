/**
 * Jira TicketProvider implementation.
 *
 * Composes:
 *   - `JiraClient` for HTTP + auth + 429 backoff
 *   - `normalize` for REST-JSON -> Normalized* conversion
 *   - `webhook` for signature verification + webhook normalisation
 *   - `jql` for TicketQuery -> JQL translation
 *
 * Write ops gate on `ctx.writeEnabled` and throw `TicketWriteDisabledError`
 * when it is false. `ctx.credentials.baseUrl` must point at the Jira instance
 * root (e.g. https://acme.atlassian.net); the REST API is mounted at
 * `/rest/api/3/` underneath.
 *
 * What is NOT implemented (deliberate punts, flagged in the follow-up issue):
 *   - Attachments (would need multipart upload + body-reference munging).
 *   - Sub-task creation via parent linking (can be approximated through
 *     customfield_10014 on update, but Jira requires the Epic Link custom field
 *     id per-instance -- field discovery is out of scope for this landing).
 *   - OAuth token refresh -- expired bearers surface as 401 JiraApiError.
 *   - qsh (query-string hash) validation on Connect JWTs.
 *   - RS256-signed Connect 2.0 tokens (requires JWK fetch).
 */

import type {
  NormalizedActivity,
  NormalizedComment,
  NormalizedTicket,
  NormalizedTicketEvent,
  RichText,
  TicketContext,
  TicketPatch,
  TicketProvider,
  TicketProviderKind,
  TicketQuery,
} from "../../types.js";
import { TicketNotFoundError, TicketWriteDisabledError } from "../../types.js";
import { mdxToAdf } from "../../richtext/adf.js";
import { JiraApiError, JiraClient, type FetchLike, type JiraClientOptions } from "./client.js";
import {
  normalizeChangelog,
  normalizeComment,
  normalizeIssue,
  type JiraChangelogHistory,
  type JiraComment,
  type JiraIssue,
} from "./normalize.js";
import { queryToJql } from "./jql.js";
import { normalizeWebhookPayload, verifyWebhookSignature, type JiraWebhookPayload } from "./webhook.js";

export interface JiraProviderOptions {
  /** Override the HTTP fetch (tests). */
  fetchImpl?: FetchLike;
  /** Client-level overrides (retry budget, backoff, sleep). */
  clientOptions?: Partial<Omit<JiraClientOptions, "credentials" | "fetchImpl">>;
  /** Web base URL override for constructing ticket permalinks. Defaults to credentials.baseUrl. */
  webBaseUrl?: string;
}

const MAX_SEARCH_LIMIT = 100;

export class JiraProvider implements TicketProvider {
  readonly kind: TicketProviderKind = "jira";
  private readonly opts: JiraProviderOptions;

  constructor(opts: JiraProviderOptions = {}) {
    this.opts = opts;
  }

  private buildClient(ctx: TicketContext): JiraClient {
    return new JiraClient({
      credentials: ctx.credentials,
      fetchImpl: this.opts.fetchImpl,
      ...(this.opts.clientOptions ?? {}),
    });
  }

  private webBase(ctx: TicketContext): string | undefined {
    return this.opts.webBaseUrl ?? ctx.credentials.baseUrl;
  }

  // Read

  async getIssue(id: string, ctx: TicketContext): Promise<NormalizedTicket | null> {
    const client = this.buildClient(ctx);
    try {
      const issue = await client.request<JiraIssue>({
        method: "GET",
        path: `/rest/api/3/issue/${encodeURIComponent(id)}`,
        query: { fields: "*all", expand: "renderedFields,changelog" },
      });
      return normalizeIssue(issue, { tenantId: ctx.tenantId, webBaseUrl: this.webBase(ctx) });
    } catch (err) {
      if (err instanceof JiraApiError && err.status === 404) return null;
      throw err;
    }
  }

  async searchIssues(
    query: TicketQuery,
    ctx: TicketContext,
  ): Promise<{ tickets: NormalizedTicket[]; cursor?: string }> {
    const client = this.buildClient(ctx);
    const jql = queryToJql(query);
    const limit = Math.min(query.limit ?? 50, MAX_SEARCH_LIMIT);
    const startAt = query.cursor ? Number(query.cursor) : 0;
    const payload = {
      jql: jql ? `${jql} ORDER BY updated DESC` : "ORDER BY updated DESC",
      startAt: Number.isFinite(startAt) ? startAt : 0,
      maxResults: limit,
      fields: ["*all"],
      expand: ["renderedFields"],
    };
    const response = await client.request<{
      issues: JiraIssue[];
      startAt: number;
      maxResults: number;
      total: number;
    }>({
      method: "POST",
      path: "/rest/api/3/search",
      body: payload,
    });
    const tickets = (response.issues ?? []).map((issue) =>
      normalizeIssue(issue, { tenantId: ctx.tenantId, webBaseUrl: this.webBase(ctx) }),
    );
    const nextStart = (response.startAt ?? 0) + tickets.length;
    const more = nextStart < (response.total ?? 0);
    return { tickets, cursor: more ? String(nextStart) : undefined };
  }

  async listComments(id: string, ctx: TicketContext): Promise<NormalizedComment[]> {
    const client = this.buildClient(ctx);
    const response = await client.request<{ comments: JiraComment[] }>({
      method: "GET",
      path: `/rest/api/3/issue/${encodeURIComponent(id)}/comment`,
      query: { expand: "renderedBody" },
    });
    return (response.comments ?? []).map((c) => normalizeComment(c, id));
  }

  async listActivity(id: string, ctx: TicketContext): Promise<NormalizedActivity[]> {
    const client = this.buildClient(ctx);
    const issue = await client.request<JiraIssue>({
      method: "GET",
      path: `/rest/api/3/issue/${encodeURIComponent(id)}`,
      query: { fields: "summary", expand: "changelog" },
    });
    const histories: JiraChangelogHistory[] = issue.changelog?.histories ?? [];
    return histories.map((h) => normalizeChangelog(h, id));
  }

  // Write

  private ensureWrite(ctx: TicketContext, op: string): void {
    if (!ctx.writeEnabled) throw new TicketWriteDisabledError("jira", op);
  }

  async postComment(id: string, body: RichText, ctx: TicketContext): Promise<NormalizedComment> {
    this.ensureWrite(ctx, "postComment");
    const client = this.buildClient(ctx);
    const adfBody = mdxToAdf(body);
    const response = await client.request<JiraComment>({
      method: "POST",
      path: `/rest/api/3/issue/${encodeURIComponent(id)}/comment`,
      body: { body: adfBody },
    });
    return normalizeComment(response, id);
  }

  async updateIssue(id: string, patch: TicketPatch, ctx: TicketContext): Promise<NormalizedTicket> {
    this.ensureWrite(ctx, "updateIssue");
    const client = this.buildClient(ctx);
    const fields: Record<string, unknown> = {};
    if (patch.title !== undefined) fields.summary = patch.title;
    if (patch.body !== undefined) fields.description = mdxToAdf(patch.body);
    if (patch.assigneeId !== undefined) {
      fields.assignee = patch.assigneeId === null ? null : { accountId: patch.assigneeId };
    }
    if (patch.priority !== undefined) {
      fields.priority = patch.priority === null ? null : { name: patch.priority };
    }
    if (patch.labels !== undefined) fields.labels = patch.labels;
    if (patch.parentId !== undefined) {
      fields.parent = patch.parentId === null ? null : { id: patch.parentId };
    }
    if (patch.customFields) {
      for (const [k, v] of Object.entries(patch.customFields)) fields[k] = v;
    }
    await client.request({
      method: "PUT",
      path: `/rest/api/3/issue/${encodeURIComponent(id)}`,
      body: { fields },
    });
    const updated = await this.getIssue(id, ctx);
    if (!updated) throw new TicketNotFoundError("jira", id);
    return updated;
  }

  async transitionStatus(id: string, target: string, ctx: TicketContext): Promise<NormalizedTicket> {
    this.ensureWrite(ctx, "transitionStatus");
    const client = this.buildClient(ctx);
    const transitions = await client.request<{
      transitions: { id: string; name: string; to?: { name?: string } }[];
    }>({
      method: "GET",
      path: `/rest/api/3/issue/${encodeURIComponent(id)}/transitions`,
    });
    const t = (transitions.transitions ?? []).find(
      (x) => x.name?.toLowerCase() === target.toLowerCase() || x.to?.name?.toLowerCase() === target.toLowerCase(),
    );
    if (!t) throw new Error(`JiraProvider.transitionStatus: no transition named "${target}" on issue ${id}`);
    await client.request({
      method: "POST",
      path: `/rest/api/3/issue/${encodeURIComponent(id)}/transitions`,
      body: { transition: { id: t.id } },
    });
    const updated = await this.getIssue(id, ctx);
    if (!updated) throw new TicketNotFoundError("jira", id);
    return updated;
  }

  async addLabel(id: string, label: string, ctx: TicketContext): Promise<void> {
    this.ensureWrite(ctx, "addLabel");
    const client = this.buildClient(ctx);
    const issue = await client.request<JiraIssue>({
      method: "GET",
      path: `/rest/api/3/issue/${encodeURIComponent(id)}`,
      query: { fields: "labels" },
    });
    const existing = issue.fields.labels ?? [];
    if (existing.includes(label)) return;
    const next = [...existing, label];
    await client.request({
      method: "PUT",
      path: `/rest/api/3/issue/${encodeURIComponent(id)}`,
      body: { fields: { labels: next } },
    });
  }

  async removeLabel(id: string, label: string, ctx: TicketContext): Promise<void> {
    this.ensureWrite(ctx, "removeLabel");
    const client = this.buildClient(ctx);
    const issue = await client.request<JiraIssue>({
      method: "GET",
      path: `/rest/api/3/issue/${encodeURIComponent(id)}`,
      query: { fields: "labels" },
    });
    const existing = issue.fields.labels ?? [];
    if (!existing.includes(label)) return;
    const next = existing.filter((l) => l !== label);
    await client.request({
      method: "PUT",
      path: `/rest/api/3/issue/${encodeURIComponent(id)}`,
      body: { fields: { labels: next } },
    });
  }

  // Webhook

  normalizeWebhook(
    payload: unknown,
    _headers: Record<string, string>,
    ctx: TicketContext,
  ): NormalizedTicketEvent | null {
    if (!payload || typeof payload !== "object") return null;
    return normalizeWebhookPayload(payload as JiraWebhookPayload, {
      tenantId: ctx.tenantId,
      webBaseUrl: this.webBase(ctx),
    });
  }

  verifySignature(headers: Record<string, string>, body: string, ctx: TicketContext): boolean {
    return verifyWebhookSignature(headers, body, ctx);
  }

  // Health

  async testConnection(ctx: TicketContext): Promise<{ ok: boolean; error?: string }> {
    try {
      const client = this.buildClient(ctx);
      await client.request<{ accountId?: string }>({
        method: "GET",
        path: "/rest/api/3/myself",
      });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }
}
