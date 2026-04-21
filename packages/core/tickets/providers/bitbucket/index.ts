/**
 * Bitbucket Cloud Issues TicketProvider implementation.
 *
 * Ref format: `"workspace/repo#N"`.
 *
 * Body format: BB uses a `{type:"rendered", markup:"markdown", raw:"..."}`
 * content envelope. We round-trip through `raw` + markdownToMdx.
 *
 * Labels: BB Issues have no native labels; we model `component` / `milestone`
 * / `version` as `"scope:value"` pseudo-labels on read, and `addLabel` /
 * `removeLabel` throw "labels not supported" to avoid silent data loss.
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
import { BitbucketClient, type BitbucketPage } from "./client.js";
import {
  normalizeComment,
  normalizeIssue,
  normalizeUser,
  parseRef,
  type BbComment,
  type BbIssue,
  type BbUser,
} from "./normalize.js";
import { buildBbql } from "./query.js";
import { normalizeWebhook, verifySignature } from "./webhook.js";

export interface BitbucketProviderOptions {
  clientFactory?: (ctx: TicketContext) => BitbucketClient;
}

export class BitbucketProvider implements TicketProvider {
  kind = "bitbucket" as const;
  private readonly clientFactory: (ctx: TicketContext) => BitbucketClient;

  constructor(opts: BitbucketProviderOptions = {}) {
    this.clientFactory = opts.clientFactory ?? ((ctx) => new BitbucketClient({ credentials: ctx.credentials }));
  }

  async getIssue(ref: string, ctx: TicketContext): Promise<NormalizedTicket | null> {
    const { workspace, repo, id } = parseRef(ref);
    const client = this.clientFactory(ctx);
    const res = await client.get<BbIssue | null>(`/repositories/${workspace}/${repo}/issues/${id}`);
    if (res.status === 404 || !res.data) return null;
    const issue = { ...res.data, repository: { full_name: `${workspace}/${repo}` } };
    return normalizeIssue(issue, ctx.tenantId);
  }

  async searchIssues(
    query: TicketQuery,
    ctx: TicketContext,
  ): Promise<{ tickets: NormalizedTicket[]; cursor?: string }> {
    const client = this.clientFactory(ctx);
    const scope = ctx.credentials.extra as { workspace?: string; repo?: string } | undefined;
    if (!scope?.workspace || !scope?.repo) {
      throw new Error("Bitbucket searchIssues requires credentials.extra.workspace + .repo");
    }
    const bbql = buildBbql(query);
    const limit = Math.min(query.limit ?? 50, 100);
    const qstr = encodeURIComponent(bbql);
    const url =
      query.cursor ??
      `/repositories/${scope.workspace}/${scope.repo}/issues?pagelen=${limit}${bbql ? `&q=${qstr}` : ""}`;
    const res = await client.get<BitbucketPage<BbIssue>>(url);
    const tickets = (res.data?.values ?? []).map((i) =>
      normalizeIssue({ ...i, repository: { full_name: `${scope.workspace}/${scope.repo}` } }, ctx.tenantId),
    );
    return { tickets, cursor: res.nextCursor ?? undefined };
  }

  async listComments(ref: string, ctx: TicketContext): Promise<NormalizedComment[]> {
    const { workspace, repo, id } = parseRef(ref);
    const client = this.clientFactory(ctx);
    const items = await client.paginate<BbComment>(`/repositories/${workspace}/${repo}/issues/${id}/comments`);
    return items.map((c) => normalizeComment(c, ref));
  }

  async listActivity(ref: string, ctx: TicketContext): Promise<NormalizedActivity[]> {
    const { workspace, repo, id } = parseRef(ref);
    const client = this.clientFactory(ctx);
    interface BbChange {
      id?: number;
      created_on: string;
      user: BbUser | null;
      changes?: Record<string, { old: unknown; new: unknown }>;
    }
    const items = await client.paginate<BbChange>(`/repositories/${workspace}/${repo}/issues/${id}/changes`);
    return items.map((c, idx) => {
      const fields = Object.keys(c.changes ?? {});
      const kind: NormalizedActivity["kind"] = fields.includes("state")
        ? "transitioned"
        : fields.includes("assignee")
          ? "assigned"
          : fields.length
            ? "field_changed"
            : "other";
      return {
        id: String(c.id ?? idx),
        ticketId: ref,
        actor: normalizeUser(c.user),
        kind,
        changes: c.changes ?? {},
        at: c.created_on,
        raw: c,
      };
    });
  }

  async postComment(ref: string, body: RichText, ctx: TicketContext): Promise<NormalizedComment> {
    if (!ctx.writeEnabled) throw new TicketWriteDisabledError("bitbucket", "postComment");
    const { workspace, repo, id } = parseRef(ref);
    const client = this.clientFactory(ctx);
    const res = await client.post<BbComment>(`/repositories/${workspace}/${repo}/issues/${id}/comments`, {
      content: { raw: mdxToMarkdown(body) },
    });
    return normalizeComment(res.data, ref);
  }

  async updateIssue(ref: string, patch: TicketPatch, ctx: TicketContext): Promise<NormalizedTicket> {
    if (!ctx.writeEnabled) throw new TicketWriteDisabledError("bitbucket", "updateIssue");
    const { workspace, repo, id } = parseRef(ref);
    const client = this.clientFactory(ctx);
    const body: Record<string, unknown> = {};
    if (patch.title != null) body.title = patch.title;
    if (patch.body != null) body.content = { raw: mdxToMarkdown(patch.body) };
    if (patch.assigneeId !== undefined) {
      body.assignee = patch.assigneeId === null ? null : { uuid: patch.assigneeId };
    }
    if (patch.priority != null) body.priority = patch.priority;
    if (patch.customFields) Object.assign(body, patch.customFields);
    // parentId + labels are not modelable on BB Issues; caller-facing silent drop.
    const res = await client.put<BbIssue>(`/repositories/${workspace}/${repo}/issues/${id}`, body);
    const withRepo = { ...res.data, repository: { full_name: `${workspace}/${repo}` } };
    return normalizeIssue(withRepo, ctx.tenantId);
  }

  async transitionStatus(ref: string, target: string, ctx: TicketContext): Promise<NormalizedTicket> {
    if (!ctx.writeEnabled) throw new TicketWriteDisabledError("bitbucket", "transitionStatus");
    const state = mapTargetToState(target);
    const { workspace, repo, id } = parseRef(ref);
    const client = this.clientFactory(ctx);
    const res = await client.put<BbIssue>(`/repositories/${workspace}/${repo}/issues/${id}`, { state });
    const withRepo = { ...res.data, repository: { full_name: `${workspace}/${repo}` } };
    return normalizeIssue(withRepo, ctx.tenantId);
  }

  async addLabel(_ref: string, _label: string, ctx: TicketContext): Promise<void> {
    if (!ctx.writeEnabled) throw new TicketWriteDisabledError("bitbucket", "addLabel");
    throw new Error(
      "Bitbucket: labels not supported on Cloud Issues (use component/milestone/version via updateIssue.customFields)",
    );
  }

  async removeLabel(_ref: string, _label: string, ctx: TicketContext): Promise<void> {
    if (!ctx.writeEnabled) throw new TicketWriteDisabledError("bitbucket", "removeLabel");
    throw new Error("Bitbucket: labels not supported on Cloud Issues");
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

function mapTargetToState(target: string): string {
  switch (target) {
    case "todo":
    case "new":
      return "new";
    case "in_progress":
    case "open":
      return "open";
    case "done":
    case "resolved":
    case "completed":
      return "resolved";
    case "closed":
      return "closed";
    case "cancelled":
    case "wontfix":
      return "wontfix";
    case "invalid":
      return "invalid";
    case "on_hold":
    case "on hold":
      return "on hold";
    default:
      throw new Error(`Bitbucket: unsupported transition target "${target}"`);
  }
}

export function createBitbucketProvider(): TicketProvider {
  return new BitbucketProvider();
}
