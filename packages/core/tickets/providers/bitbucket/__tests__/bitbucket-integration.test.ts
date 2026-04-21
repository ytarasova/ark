import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { markdownToMdx } from "../../../richtext/markdown.js";
import { TicketWriteDisabledError, type TicketContext } from "../../../types.js";
import { BitbucketClient } from "../client.js";
import { BitbucketProvider } from "../index.js";

const HERE = new URL(".", import.meta.url).pathname;
function load(name: string): unknown {
  return JSON.parse(readFileSync(join(HERE, "..", "fixtures", name), "utf8"));
}

interface Call {
  method: string;
  url: string;
  body?: unknown;
}

function mockClient(
  handlers: Array<{ match: RegExp; method?: string; status?: number; body?: unknown }>,
  calls: Call[],
): BitbucketClient {
  const fetchImpl: typeof fetch = async (input, init) => {
    const method = init?.method ?? "GET";
    const url = String(input);
    calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const h = handlers.find((x) => x.match.test(url) && (!x.method || x.method === method));
    if (!h) return new Response("nf", { status: 404 });
    return new Response(h.body !== undefined ? JSON.stringify(h.body) : null, {
      status: h.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  };
  return new BitbucketClient({ credentials: { bearer: "tok" }, fetch: fetchImpl });
}

function ctx(writeEnabled: boolean, extra?: Record<string, unknown>): TicketContext {
  return { tenantId: "t1", credentials: { bearer: "tok", extra }, writeEnabled };
}

describe("BitbucketProvider integration", () => {
  it("getIssue -> normalized ticket", async () => {
    const calls: Call[] = [];
    const client = mockClient([{ match: /issues\/7$/, body: load("issue.json") }], calls);
    const provider = new BitbucketProvider({ clientFactory: () => client });
    const t = await provider.getIssue("acme/widgets#7", ctx(false));
    expect(t?.id).toBe("acme/widgets#7");
    expect(calls[0].url).toContain("/repositories/acme/widgets/issues/7");
  });

  it("postComment refuses when writeEnabled=false", async () => {
    const provider = new BitbucketProvider({ clientFactory: () => mockClient([], []) });
    expect(provider.postComment("acme/widgets#7", markdownToMdx("hi"), ctx(false))).rejects.toBeInstanceOf(
      TicketWriteDisabledError,
    );
  });

  it("postComment sends content.raw in markdown", async () => {
    const calls: Call[] = [];
    const client = mockClient(
      [
        {
          match: /issues\/7\/comments$/,
          method: "POST",
          body: {
            id: 9999,
            content: { raw: "**hi**" },
            user: { uuid: "{u}", display_name: "me" },
            created_on: "2024-01-01T00:00:00Z",
            updated_on: "2024-01-01T00:00:00Z",
          },
        },
      ],
      calls,
    );
    const provider = new BitbucketProvider({ clientFactory: () => client });
    const c = await provider.postComment("acme/widgets#7", markdownToMdx("**hi**"), ctx(true));
    expect(c.id).toBe("9999");
    const sent = calls[0].body as { content: { raw: string } };
    expect(sent.content.raw).toContain("**hi**");
  });

  it("updateIssue wraps body in content.raw and sets assignee.uuid", async () => {
    const calls: Call[] = [];
    const client = mockClient([{ match: /issues\/7$/, method: "PUT", body: load("issue.json") }], calls);
    const provider = new BitbucketProvider({ clientFactory: () => client });
    await provider.updateIssue(
      "acme/widgets#7",
      { title: "new", body: markdownToMdx("body"), assigneeId: "{uuid-xyz}" },
      ctx(true),
    );
    const sent = calls[0].body as Record<string, unknown>;
    expect(sent.title).toBe("new");
    expect((sent.content as { raw: string }).raw).toContain("body");
    expect(sent.assignee).toEqual({ uuid: "{uuid-xyz}" });
  });

  it("transitionStatus maps done -> resolved", async () => {
    const calls: Call[] = [];
    const client = mockClient([{ match: /issues\/7$/, method: "PUT", body: load("issue.json") }], calls);
    const provider = new BitbucketProvider({ clientFactory: () => client });
    await provider.transitionStatus("acme/widgets#7", "done", ctx(true));
    expect((calls[0].body as { state: string }).state).toBe("resolved");
  });

  it("transitionStatus maps cancelled -> wontfix", async () => {
    const calls: Call[] = [];
    const client = mockClient([{ match: /issues\/7$/, method: "PUT", body: load("issue.json") }], calls);
    const provider = new BitbucketProvider({ clientFactory: () => client });
    await provider.transitionStatus("acme/widgets#7", "cancelled", ctx(true));
    expect((calls[0].body as { state: string }).state).toBe("wontfix");
  });

  it("transitionStatus rejects unknown targets", async () => {
    const provider = new BitbucketProvider({ clientFactory: () => mockClient([], []) });
    expect(provider.transitionStatus("acme/widgets#7", "weird", ctx(true))).rejects.toThrow(/unsupported transition/);
  });

  it("addLabel / removeLabel throw clearly (not supported)", async () => {
    const provider = new BitbucketProvider({ clientFactory: () => mockClient([], []) });
    expect(provider.addLabel("acme/widgets#7", "bug", ctx(true))).rejects.toThrow(/labels not supported/);
    expect(provider.removeLabel("acme/widgets#7", "bug", ctx(true))).rejects.toThrow(/labels not supported/);
  });

  it("searchIssues requires workspace+repo in credentials.extra", async () => {
    const provider = new BitbucketProvider({ clientFactory: () => mockClient([], []) });
    expect(provider.searchIssues({}, ctx(false))).rejects.toThrow(/workspace/);
  });

  it("searchIssues hits the issues endpoint with BBQL", async () => {
    const calls: Call[] = [];
    const client = mockClient(
      [{ match: /issues\?pagelen/, body: { values: [load("issue.json")], next: undefined } }],
      calls,
    );
    const provider = new BitbucketProvider({ clientFactory: () => client });
    const { tickets } = await provider.searchIssues(
      { statusCategories: ["in_progress"] },
      ctx(false, { workspace: "acme", repo: "widgets" }),
    );
    expect(tickets).toHaveLength(1);
    expect(calls[0].url).toContain("/repositories/acme/widgets/issues");
    expect(calls[0].url).toContain("q=");
  });

  it("listComments paginates the comments endpoint", async () => {
    const calls: Call[] = [];
    const client = mockClient([{ match: /issues\/7\/comments/, body: { values: [load("comment.json")] } }], calls);
    const provider = new BitbucketProvider({ clientFactory: () => client });
    const comments = await provider.listComments("acme/widgets#7", ctx(false));
    expect(comments).toHaveLength(1);
    expect(comments[0].ticketId).toBe("acme/widgets#7");
    expect(calls[0].url).toContain("/repositories/acme/widgets/issues/7/comments");
  });

  it("listActivity classifies state / assignee / field changes", async () => {
    const calls: Call[] = [];
    const client = mockClient(
      [
        {
          match: /issues\/7\/changes/,
          body: {
            values: [
              {
                id: 1,
                created_on: "2024-01-01T00:00:00Z",
                user: { uuid: "{u1}", display_name: "alice" },
                changes: { state: { old: "new", new: "open" } },
              },
              {
                id: 2,
                created_on: "2024-01-01T00:01:00Z",
                user: { uuid: "{u2}", display_name: "bob" },
                changes: { assignee: { old: null, new: "{u-b}" } },
              },
              {
                id: 3,
                created_on: "2024-01-01T00:02:00Z",
                user: { uuid: "{u1}", display_name: "alice" },
                changes: { title: { old: "a", new: "b" } },
              },
            ],
          },
        },
      ],
      calls,
    );
    const provider = new BitbucketProvider({ clientFactory: () => client });
    const events = await provider.listActivity("acme/widgets#7", ctx(false));
    expect(events).toHaveLength(3);
    expect(events[0].kind).toBe("transitioned");
    expect(events[1].kind).toBe("assigned");
    expect(events[2].kind).toBe("field_changed");
  });

  it("testConnection returns ok on /user 200", async () => {
    const client = mockClient([{ match: /\/user$/, body: { account_id: "ok" } }], []);
    const provider = new BitbucketProvider({ clientFactory: () => client });
    const res = await provider.testConnection(ctx(false));
    expect(res.ok).toBe(true);
  });

  it("testConnection returns ok=false on failure", async () => {
    const fetchImpl: typeof fetch = async () => new Response("no", { status: 500 });
    const failing = new BitbucketClient({ credentials: { bearer: "tok" }, fetch: fetchImpl });
    const provider = new BitbucketProvider({ clientFactory: () => failing });
    const res = await provider.testConnection(ctx(false));
    expect(res.ok).toBe(false);
    expect(res.error).toBeDefined();
  });
});
