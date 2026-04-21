/**
 * Linear TicketProvider implementation.
 *
 * Ref format: `"ENG-123"` (issue identifier). Linear's `issue(id: ...)` query
 * happily accepts either the UUID or the identifier string.
 *
 * Body format: Markdown on the wire in both directions (Linear renders
 * markdown to ProseMirror in its UI, but the API takes / returns markdown).
 *
 * Transitions: Linear stores status as a workflow state row per team. We
 * resolve the target state by fetching the team's workflow states and
 * matching on name (case-insensitive) or state type (`started`, `completed`,
 * `canceled` etc.). Unknown targets throw.
 *
 * Labels: Linear labels are entities with ids, scoped per-team. We look up
 * or fail explicitly rather than create new labels silently.
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
import {
  GET_ISSUE_QUERY,
  ISSUE_LABELS_QUERY,
  LIST_COMMENTS_QUERY,
  LIST_HISTORY_QUERY,
  LinearClient,
  POST_COMMENT_MUTATION,
  SEARCH_ISSUES_QUERY,
  TEAM_LABELS_QUERY,
  UPDATE_ISSUE_MUTATION,
  WORKFLOW_STATES_QUERY,
} from "./client.js";
import {
  normalizeComment,
  normalizeIssue,
  normalizeUser,
  type LinearComment,
  type LinearIssue,
  type LinearUser,
} from "./normalize.js";
import { buildIssueFilter } from "./query.js";
import { normalizeWebhook, verifySignature } from "./webhook.js";

export interface LinearProviderOptions {
  clientFactory?: (ctx: TicketContext) => LinearClient;
}

export class LinearProvider implements TicketProvider {
  kind = "linear" as const;
  private readonly clientFactory: (ctx: TicketContext) => LinearClient;

  constructor(opts: LinearProviderOptions = {}) {
    this.clientFactory = opts.clientFactory ?? ((ctx) => new LinearClient({ credentials: ctx.credentials }));
  }

  async getIssue(ref: string, ctx: TicketContext): Promise<NormalizedTicket | null> {
    const client = this.clientFactory(ctx);
    const res = await client.request<{ issue: LinearIssue | null }>(GET_ISSUE_QUERY, { id: ref });
    if (!res.data.issue) return null;
    return normalizeIssue(res.data.issue, ctx.tenantId);
  }

  async searchIssues(
    query: TicketQuery,
    ctx: TicketContext,
  ): Promise<{ tickets: NormalizedTicket[]; cursor?: string }> {
    const client = this.clientFactory(ctx);
    const { filter, first } = buildIssueFilter(query);
    const res = await client.request<{
      issues: { nodes: LinearIssue[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } };
    }>(SEARCH_ISSUES_QUERY, { filter, first, after: query.cursor ?? null });
    const conn = res.data.issues;
    return {
      tickets: conn.nodes.map((i) => normalizeIssue(i, ctx.tenantId)),
      cursor: conn.pageInfo.hasNextPage && conn.pageInfo.endCursor ? conn.pageInfo.endCursor : undefined,
    };
  }

  async listComments(ref: string, ctx: TicketContext): Promise<NormalizedComment[]> {
    const client = this.clientFactory(ctx);
    const nodes = await client.paginate<
      LinearComment,
      { issue: { comments: { nodes: LinearComment[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } } }
    >(LIST_COMMENTS_QUERY, { id: ref, first: 100 }, (d) => d.issue.comments);
    return nodes.map((c) => normalizeComment(c, ref));
  }

  async listActivity(ref: string, ctx: TicketContext): Promise<NormalizedActivity[]> {
    const client = this.clientFactory(ctx);
    interface HistoryNode {
      id: string;
      createdAt: string;
      actor: LinearUser | null;
      fromStateId: string | null;
      toStateId: string | null;
      fromAssigneeId: string | null;
      toAssigneeId: string | null;
      addedLabelIds: string[] | null;
      removedLabelIds: string[] | null;
    }
    const nodes = await client.paginate<
      HistoryNode,
      {
        issue: {
          history: { nodes: HistoryNode[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } };
        };
      }
    >(LIST_HISTORY_QUERY, { id: ref, first: 100 }, (d) => d.issue.history);

    return nodes.map((h) => {
      const changes: Record<string, { old: unknown; new: unknown }> = {};
      let kind: NormalizedActivity["kind"] = "other";
      if (h.fromStateId || h.toStateId) {
        kind = "transitioned";
        changes.state = { old: h.fromStateId, new: h.toStateId };
      } else if (h.fromAssigneeId || h.toAssigneeId) {
        kind = h.toAssigneeId ? "assigned" : "unassigned";
        changes.assignee = { old: h.fromAssigneeId, new: h.toAssigneeId };
      } else if (h.addedLabelIds?.length) {
        kind = "labeled";
        changes.labels = { old: null, new: h.addedLabelIds };
      } else if (h.removedLabelIds?.length) {
        kind = "unlabeled";
        changes.labels = { old: h.removedLabelIds, new: null };
      }
      return {
        id: h.id,
        ticketId: ref,
        actor: normalizeUser(h.actor),
        kind,
        changes,
        at: h.createdAt,
        raw: h,
      };
    });
  }

  async postComment(ref: string, body: RichText, ctx: TicketContext): Promise<NormalizedComment> {
    if (!ctx.writeEnabled) throw new TicketWriteDisabledError("linear", "postComment");
    const client = this.clientFactory(ctx);
    const res = await client.request<{ commentCreate: { success: boolean; comment: LinearComment } }>(
      POST_COMMENT_MUTATION,
      { input: { issueId: ref, body: mdxToMarkdown(body) } },
    );
    return normalizeComment(res.data.commentCreate.comment, ref);
  }

  async updateIssue(ref: string, patch: TicketPatch, ctx: TicketContext): Promise<NormalizedTicket> {
    if (!ctx.writeEnabled) throw new TicketWriteDisabledError("linear", "updateIssue");
    const client = this.clientFactory(ctx);
    const input: Record<string, unknown> = {};
    if (patch.title != null) input.title = patch.title;
    if (patch.body != null) input.description = mdxToMarkdown(patch.body);
    if (patch.assigneeId !== undefined) input.assigneeId = patch.assigneeId;
    if (patch.priority != null) input.priority = Number(patch.priority);
    if (patch.labels != null) {
      input.labelIds = await resolveLabelIds(client, ref, patch.labels);
    }
    if (patch.parentId !== undefined) input.parentId = patch.parentId;
    if (patch.customFields) Object.assign(input, patch.customFields);
    const res = await client.request<{ issueUpdate: { success: boolean; issue: LinearIssue } }>(UPDATE_ISSUE_MUTATION, {
      id: ref,
      input,
    });
    return normalizeIssue(res.data.issueUpdate.issue, ctx.tenantId);
  }

  async transitionStatus(ref: string, target: string, ctx: TicketContext): Promise<NormalizedTicket> {
    if (!ctx.writeEnabled) throw new TicketWriteDisabledError("linear", "transitionStatus");
    const client = this.clientFactory(ctx);
    const teamId = await resolveTeamId(client, ref);
    const states = await client.request<{
      workflowStates: { nodes: Array<{ id: string; name: string; type: string }> };
    }>(WORKFLOW_STATES_QUERY, { teamId });
    const stateId = pickState(states.data.workflowStates.nodes, target);
    if (!stateId) throw new Error(`Linear: no workflow state matches target "${target}" for team ${teamId}`);
    const res = await client.request<{ issueUpdate: { success: boolean; issue: LinearIssue } }>(UPDATE_ISSUE_MUTATION, {
      id: ref,
      input: { stateId },
    });
    return normalizeIssue(res.data.issueUpdate.issue, ctx.tenantId);
  }

  async addLabel(ref: string, label: string, ctx: TicketContext): Promise<void> {
    if (!ctx.writeEnabled) throw new TicketWriteDisabledError("linear", "addLabel");
    const client = this.clientFactory(ctx);
    const current = await fetchIssueLabels(client, ref);
    const teamId = current.teamId;
    const newId = await findOrFailLabelId(client, teamId, label);
    const labelIds = dedupe([...current.labelIds, newId]);
    await client.request(UPDATE_ISSUE_MUTATION, { id: ref, input: { labelIds } });
  }

  async removeLabel(ref: string, label: string, ctx: TicketContext): Promise<void> {
    if (!ctx.writeEnabled) throw new TicketWriteDisabledError("linear", "removeLabel");
    const client = this.clientFactory(ctx);
    const current = await fetchIssueLabels(client, ref);
    const teamLabels = await fetchTeamLabels(client, current.teamId);
    const target = teamLabels.find((l) => l.name.toLowerCase() === label.toLowerCase());
    if (!target) return; // nothing to remove.
    const labelIds = current.labelIds.filter((id) => id !== target.id);
    await client.request(UPDATE_ISSUE_MUTATION, { id: ref, input: { labelIds } });
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
      await client.request("{ viewer { id } }");
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }
}

function pickState(nodes: Array<{ id: string; name: string; type: string }>, target: string): string | null {
  const lower = target.toLowerCase();
  // Direct name match first.
  const byName = nodes.find((n) => n.name.toLowerCase() === lower);
  if (byName) return byName.id;
  // Then state-type category match.
  const typeMap: Record<string, string[]> = {
    todo: ["triage", "backlog", "unstarted"],
    in_progress: ["started"],
    done: ["completed"],
    cancelled: ["canceled"],
  };
  const types = typeMap[lower];
  if (!types) return null;
  for (const t of types) {
    const n = nodes.find((x) => x.type === t);
    if (n) return n.id;
  }
  return null;
}

async function resolveTeamId(client: LinearClient, ref: string): Promise<string> {
  const res = await client.request<{ issue: { team: { id: string } } | null }>(
    `query TeamOf($id: String!) { issue(id: $id) { id team { id } } }`,
    { id: ref },
  );
  if (!res.data.issue) throw new Error(`Linear: issue ${ref} not found`);
  return res.data.issue.team.id;
}

async function fetchIssueLabels(client: LinearClient, ref: string): Promise<{ teamId: string; labelIds: string[] }> {
  const res = await client.request<{
    issue: { team: { id: string }; labels: { nodes: Array<{ id: string; name: string }> } } | null;
  }>(ISSUE_LABELS_QUERY, { id: ref });
  if (!res.data.issue) throw new Error(`Linear: issue ${ref} not found`);
  return {
    teamId: res.data.issue.team.id,
    labelIds: res.data.issue.labels.nodes.map((l) => l.id),
  };
}

async function fetchTeamLabels(client: LinearClient, teamId: string): Promise<Array<{ id: string; name: string }>> {
  const res = await client.request<{ issueLabels: { nodes: Array<{ id: string; name: string }> } }>(TEAM_LABELS_QUERY, {
    teamId,
  });
  return res.data.issueLabels.nodes;
}

async function findOrFailLabelId(client: LinearClient, teamId: string, name: string): Promise<string> {
  const labels = await fetchTeamLabels(client, teamId);
  const lower = name.toLowerCase();
  const hit = labels.find((l) => l.name.toLowerCase() === lower);
  if (!hit) throw new Error(`Linear: label "${name}" does not exist on team ${teamId}`);
  return hit.id;
}

async function resolveLabelIds(client: LinearClient, ref: string, names: string[]): Promise<string[]> {
  const current = await fetchIssueLabels(client, ref);
  const all = await fetchTeamLabels(client, current.teamId);
  const byName = new Map(all.map((l) => [l.name.toLowerCase(), l.id]));
  const out: string[] = [];
  for (const n of names) {
    const id = byName.get(n.toLowerCase());
    if (!id) throw new Error(`Linear: label "${n}" does not exist on team ${current.teamId}`);
    out.push(id);
  }
  return dedupe(out);
}

function dedupe<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

export function createLinearProvider(): TicketProvider {
  return new LinearProvider();
}
