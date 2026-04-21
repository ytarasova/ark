/**
 * Linear GraphQL client.
 *
 * One POST to `/graphql` per call. Auth is the API key verbatim in the
 * Authorization header (no `Bearer` prefix, unlike most other REST APIs).
 *
 * Rate limits: Linear returns X-RateLimit-Remaining + Retry-After. We back
 * off preemptively when remaining < 10 and on 429 we honour Retry-After
 * with a single retry.
 */

import type { TicketCredentials } from "../../types.js";

export interface LinearClientOptions {
  credentials: TicketCredentials;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export interface LinearResponse<T> {
  data: T;
  errors?: Array<{ message: string; extensions?: unknown }>;
  headers: Headers;
  remaining: number;
}

const DEFAULT_ENDPOINT = "https://api.linear.app/graphql";

export class LinearClient {
  private readonly endpoint: string;
  private readonly authHeader: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(opts: LinearClientOptions) {
    this.endpoint = opts.credentials.baseUrl ?? DEFAULT_ENDPOINT;
    const key = opts.credentials.token ?? opts.credentials.bearer ?? "";
    if (!key) throw new Error("LinearClient: credentials.token is required (no Bearer prefix)");
    this.authHeader = key; // Linear uses the raw key as Authorization value.
    this.fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async request<T>(query: string, variables: Record<string, unknown> = {}): Promise<LinearResponse<T>> {
    const body = JSON.stringify({ query, variables });
    for (let attempt = 0; attempt < 2; attempt++) {
      const resp = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: {
          authorization: this.authHeader,
          "content-type": "application/json",
          accept: "application/json",
        },
        body,
      });
      if (resp.status === 429 && attempt === 0) {
        const retry = Number(resp.headers.get("retry-after") ?? "1");
        await this.sleep(Math.max(1, retry) * 1000);
        continue;
      }
      if (!resp.ok) {
        const text = (await resp.text()).slice(0, 500);
        throw new Error(`Linear GraphQL -> ${resp.status} ${text}`);
      }
      const remaining = Number(resp.headers.get("x-ratelimit-remaining") ?? "9999");
      if (remaining < 10) {
        const retry = Number(resp.headers.get("x-ratelimit-reset") ?? "0");
        if (retry > 0) {
          const nowSec = Math.floor(Date.now() / 1000);
          const waitMs = Math.max(0, (retry - nowSec) * 1000);
          if (waitMs > 0 && waitMs < 60_000) await this.sleep(waitMs);
        }
      }
      const payload = (await resp.json()) as { data: T; errors?: LinearResponse<T>["errors"] };
      if (payload.errors?.length) {
        throw new Error(`Linear GraphQL errors: ${payload.errors.map((e) => e.message).join("; ")}`);
      }
      return { data: payload.data, errors: payload.errors, headers: resp.headers, remaining };
    }
    throw new Error("Linear: retry loop exhausted");
  }

  /**
   * Cursor-based pagination over a relay-style connection. Caller supplies a
   * query returning `{ nodes, pageInfo{ hasNextPage, endCursor } }` under some
   * top-level field, and a function to extract the connection.
   */
  async paginate<T, R>(
    query: string,
    variables: Record<string, unknown>,
    extract: (data: R) => { nodes: T[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } },
  ): Promise<T[]> {
    const out: T[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 100; i++) {
      const res = await this.request<R>(query, { ...variables, after: cursor });
      const conn = extract(res.data);
      out.push(...conn.nodes);
      if (!conn.pageInfo.hasNextPage) break;
      cursor = conn.pageInfo.endCursor;
    }
    return out;
  }
}

// GraphQL document fragments -- kept as module-level strings so they're easy
// to grep for and reason about when debugging schema drift.

export const ISSUE_FIELDS = `
  id
  identifier
  title
  description
  url
  priority
  priorityLabel
  createdAt
  updatedAt
  state { id name type }
  assignee { id name email displayName avatarUrl }
  creator { id name email displayName avatarUrl }
  labels { nodes { id name } }
  parent { id identifier }
  children { nodes { id identifier } }
  team { id key }
`;

export const GET_ISSUE_QUERY = `
  query GetIssue($id: String!) {
    issue(id: $id) { ${ISSUE_FIELDS} }
  }
`;

export const SEARCH_ISSUES_QUERY = `
  query SearchIssues($filter: IssueFilter, $first: Int!, $after: String) {
    issues(filter: $filter, first: $first, after: $after, orderBy: updatedAt) {
      nodes { ${ISSUE_FIELDS} }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

export const LIST_COMMENTS_QUERY = `
  query ListComments($id: String!, $first: Int!, $after: String) {
    issue(id: $id) {
      id
      comments(first: $first, after: $after) {
        nodes {
          id
          body
          createdAt
          updatedAt
          user { id name email displayName avatarUrl }
          parent { id }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;

export const LIST_HISTORY_QUERY = `
  query ListHistory($id: String!, $first: Int!, $after: String) {
    issue(id: $id) {
      id
      history(first: $first, after: $after) {
        nodes {
          id
          createdAt
          actor { id name email displayName avatarUrl }
          fromStateId
          toStateId
          fromAssigneeId
          toAssigneeId
          addedLabelIds
          removedLabelIds
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;

export const POST_COMMENT_MUTATION = `
  mutation CreateComment($input: CommentCreateInput!) {
    commentCreate(input: $input) {
      success
      comment {
        id
        body
        createdAt
        updatedAt
        user { id name email displayName avatarUrl }
        issue { id }
      }
    }
  }
`;

export const UPDATE_ISSUE_MUTATION = `
  mutation UpdateIssue($id: String!, $input: IssueUpdateInput!) {
    issueUpdate(id: $id, input: $input) {
      success
      issue { ${ISSUE_FIELDS} }
    }
  }
`;

export const WORKFLOW_STATES_QUERY = `
  query TeamWorkflowStates($teamId: String!) {
    workflowStates(filter: { team: { id: { eq: $teamId } } }) {
      nodes { id name type }
    }
  }
`;

export const ISSUE_LABELS_QUERY = `
  query IssueLabels($id: String!) {
    issue(id: $id) {
      id
      team { id }
      labels { nodes { id name } }
    }
  }
`;

export const TEAM_LABELS_QUERY = `
  query TeamLabels($teamId: String!) {
    issueLabels(filter: { team: { id: { eq: $teamId } } }) {
      nodes { id name }
    }
  }
`;
