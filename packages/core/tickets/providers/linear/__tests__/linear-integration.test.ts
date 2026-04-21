import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { markdownToMdx } from "../../../richtext/markdown.js";
import { TicketWriteDisabledError, type TicketContext } from "../../../types.js";
import { LinearClient } from "../client.js";
import { LinearProvider } from "../index.js";

const HERE = new URL(".", import.meta.url).pathname;
function load(name: string): unknown {
  return JSON.parse(readFileSync(join(HERE, "..", "fixtures", name), "utf8"));
}

interface Call {
  query: string;
  variables: Record<string, unknown>;
}

function mockClient(responder: (call: Call) => unknown, calls: Call[]): LinearClient {
  const fetchImpl: typeof fetch = async (_url, init) => {
    const parsed = JSON.parse(String(init?.body ?? "{}"));
    const call: Call = { query: parsed.query, variables: parsed.variables ?? {} };
    calls.push(call);
    const data = responder(call);
    return new Response(JSON.stringify({ data }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return new LinearClient({ credentials: { token: "tok" }, fetch: fetchImpl });
}

function ctx(writeEnabled: boolean): TicketContext {
  return { tenantId: "t1", credentials: { token: "tok" }, writeEnabled };
}

describe("LinearProvider integration", () => {
  it("getIssue hits the issue query", async () => {
    const calls: Call[] = [];
    const client = mockClient(() => ({ issue: load("issue.json") }), calls);
    const provider = new LinearProvider({ clientFactory: () => client });
    const t = await provider.getIssue("ENG-123", ctx(false));
    expect(t?.key).toBe("ENG-123");
    expect(calls[0].query).toContain("issue(id: $id)");
    expect(calls[0].variables.id).toBe("ENG-123");
  });

  it("postComment refuses when writeEnabled=false", async () => {
    const provider = new LinearProvider({ clientFactory: () => mockClient(() => ({}), []) });
    expect(provider.postComment("ENG-123", markdownToMdx("hi"), ctx(false))).rejects.toBeInstanceOf(
      TicketWriteDisabledError,
    );
  });

  it("postComment sends markdown body", async () => {
    const calls: Call[] = [];
    const client = mockClient(
      () => ({
        commentCreate: {
          success: true,
          comment: {
            id: "cmt-new",
            body: "**hi**",
            createdAt: "2024-01-01T00:00:00Z",
            updatedAt: "2024-01-01T00:00:00Z",
            user: { id: "me", name: "me" },
          },
        },
      }),
      calls,
    );
    const provider = new LinearProvider({ clientFactory: () => client });
    const c = await provider.postComment("ENG-123", markdownToMdx("**hi**"), ctx(true));
    expect(c.id).toBe("cmt-new");
    const input = calls[0].variables.input as { body: string; issueId: string };
    expect(input.issueId).toBe("ENG-123");
    expect(input.body).toContain("**hi**");
  });

  it("updateIssue translates patch into IssueUpdateInput", async () => {
    const calls: Call[] = [];
    const client = mockClient(() => ({ issueUpdate: { success: true, issue: load("issue.json") } }), calls);
    const provider = new LinearProvider({ clientFactory: () => client });
    await provider.updateIssue(
      "ENG-123",
      { title: "new", body: markdownToMdx("body"), priority: "3", assigneeId: null },
      ctx(true),
    );
    const input = calls[0].variables.input as Record<string, unknown>;
    expect(input.title).toBe("new");
    expect(input.description).toContain("body");
    expect(input.priority).toBe(3);
    expect(input.assigneeId).toBeNull();
  });

  it("transitionStatus resolves state via workflowStates", async () => {
    const calls: Call[] = [];
    const client = mockClient((call) => {
      if (call.query.includes("TeamOf")) return { issue: { id: "x", team: { id: "team-eng" } } };
      if (call.query.includes("workflowStates")) {
        return {
          workflowStates: {
            nodes: [
              { id: "s-backlog", name: "Backlog", type: "backlog" },
              { id: "s-started", name: "In Progress", type: "started" },
              { id: "s-done", name: "Done", type: "completed" },
            ],
          },
        };
      }
      return { issueUpdate: { success: true, issue: load("issue.json") } };
    }, calls);
    const provider = new LinearProvider({ clientFactory: () => client });
    await provider.transitionStatus("ENG-123", "in_progress", ctx(true));
    const update = calls[calls.length - 1];
    const input = update.variables.input as { stateId: string };
    expect(input.stateId).toBe("s-started");
  });

  it("transitionStatus rejects unknown target", async () => {
    const client = mockClient((call) => {
      if (call.query.includes("TeamOf")) return { issue: { id: "x", team: { id: "team-eng" } } };
      return { workflowStates: { nodes: [{ id: "s", name: "A", type: "started" }] } };
    }, []);
    const provider = new LinearProvider({ clientFactory: () => client });
    expect(provider.transitionStatus("ENG-123", "blah", ctx(true))).rejects.toThrow(/no workflow state/);
  });

  it("searchIssues forwards filter + returns cursor when present", async () => {
    const calls: Call[] = [];
    const client = mockClient(
      () => ({
        issues: {
          nodes: [load("issue.json")],
          pageInfo: { hasNextPage: true, endCursor: "next-cur" },
        },
      }),
      calls,
    );
    const provider = new LinearProvider({ clientFactory: () => client });
    const { tickets, cursor } = await provider.searchIssues({ statusCategories: ["in_progress"] }, ctx(false));
    expect(tickets).toHaveLength(1);
    expect(cursor).toBe("next-cur");
    const vars = calls[0].variables as { filter: Record<string, unknown> };
    expect(vars.filter.state).toBeDefined();
  });

  it("listComments paginates the issue.comments connection", async () => {
    const calls: Call[] = [];
    const client = mockClient(
      () => ({
        issue: {
          comments: {
            nodes: [load("comment.json")],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      }),
      calls,
    );
    const provider = new LinearProvider({ clientFactory: () => client });
    const comments = await provider.listComments("ENG-123", ctx(false));
    expect(comments).toHaveLength(1);
    expect(comments[0].id).toBe("comment-uuid-7");
    expect(comments[0].ticketId).toBe("ENG-123");
    expect(calls[0].query).toContain("comments(first:");
  });

  it("listActivity classifies state/assignee/label history", async () => {
    const calls: Call[] = [];
    const client = mockClient(
      () => ({
        issue: {
          history: {
            nodes: [
              {
                id: "h1",
                createdAt: "2024-01-01T00:00:00Z",
                actor: { id: "u1", name: "alice", displayName: "alice" },
                fromStateId: "s-a",
                toStateId: "s-b",
                fromAssigneeId: null,
                toAssigneeId: null,
                addedLabelIds: null,
                removedLabelIds: null,
              },
              {
                id: "h2",
                createdAt: "2024-01-01T00:01:00Z",
                actor: null,
                fromStateId: null,
                toStateId: null,
                fromAssigneeId: null,
                toAssigneeId: "u2",
                addedLabelIds: null,
                removedLabelIds: null,
              },
              {
                id: "h3",
                createdAt: "2024-01-01T00:02:00Z",
                actor: null,
                fromStateId: null,
                toStateId: null,
                fromAssigneeId: null,
                toAssigneeId: null,
                addedLabelIds: ["l1"],
                removedLabelIds: null,
              },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      }),
      calls,
    );
    const provider = new LinearProvider({ clientFactory: () => client });
    const events = await provider.listActivity("ENG-123", ctx(false));
    expect(events).toHaveLength(3);
    expect(events[0].kind).toBe("transitioned");
    expect(events[0].changes.state).toEqual({ old: "s-a", new: "s-b" });
    expect(events[1].kind).toBe("assigned");
    expect(events[2].kind).toBe("labeled");
  });

  it("addLabel enforces writeEnabled + fetches team labels", async () => {
    const provider = new LinearProvider({ clientFactory: () => mockClient(() => ({}), []) });
    expect(provider.addLabel("ENG-123", "bug", ctx(false))).rejects.toBeInstanceOf(TicketWriteDisabledError);
  });

  it("addLabel merges into existing labels and resolves id by name", async () => {
    const calls: Call[] = [];
    const client = mockClient((call) => {
      if (call.query.includes("IssueLabels")) {
        return { issue: { id: "x", team: { id: "team-eng" }, labels: { nodes: [{ id: "l-a", name: "a" }] } } };
      }
      if (call.query.includes("TeamLabels")) {
        return {
          issueLabels: {
            nodes: [
              { id: "l-a", name: "a" },
              { id: "l-bug", name: "bug" },
            ],
          },
        };
      }
      return { issueUpdate: { success: true, issue: load("issue.json") } };
    }, calls);
    const provider = new LinearProvider({ clientFactory: () => client });
    await provider.addLabel("ENG-123", "bug", ctx(true));
    const last = calls[calls.length - 1];
    const input = last.variables.input as { labelIds: string[] };
    expect(input.labelIds.sort()).toEqual(["l-a", "l-bug"]);
  });

  it("removeLabel is a no-op when label not found on team", async () => {
    const calls: Call[] = [];
    const client = mockClient((call) => {
      if (call.query.includes("IssueLabels")) {
        return { issue: { id: "x", team: { id: "team-eng" }, labels: { nodes: [{ id: "l-a", name: "a" }] } } };
      }
      if (call.query.includes("TeamLabels")) {
        return { issueLabels: { nodes: [{ id: "l-a", name: "a" }] } };
      }
      return { issueUpdate: { success: true, issue: load("issue.json") } };
    }, calls);
    const provider = new LinearProvider({ clientFactory: () => client });
    await provider.removeLabel("ENG-123", "missing", ctx(true));
    // Only two calls were needed (no update mutation).
    expect(calls.find((c) => c.query.includes("UpdateIssue"))).toBeUndefined();
  });

  it("testConnection returns ok on successful viewer query", async () => {
    const client = mockClient(() => ({ viewer: { id: "u-1" } }), []);
    const provider = new LinearProvider({ clientFactory: () => client });
    const res = await provider.testConnection(ctx(false));
    expect(res.ok).toBe(true);
  });

  it("testConnection returns ok=false on failure", async () => {
    const fetchImpl: typeof fetch = async () => new Response("denied", { status: 401 });
    const failing = new LinearClient({ credentials: { token: "tok" }, fetch: fetchImpl });
    const provider = new LinearProvider({ clientFactory: () => failing });
    const res = await provider.testConnection(ctx(false));
    expect(res.ok).toBe(false);
    expect(res.error).toBeDefined();
  });
});
