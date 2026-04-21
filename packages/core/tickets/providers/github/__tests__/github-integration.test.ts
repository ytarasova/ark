import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { markdownToMdx } from "../../../richtext/markdown.js";
import { TicketWriteDisabledError, type TicketContext } from "../../../types.js";
import { GithubClient } from "../client.js";
import { GithubProvider } from "../index.js";

const HERE = new URL(".", import.meta.url).pathname;
function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(join(HERE, "..", "fixtures", name), "utf8"));
}

interface RecordedCall {
  method: string;
  url: string;
  body?: unknown;
}

function mockClient(
  handlers: Array<{ match: RegExp; status?: number; body?: unknown; method?: string }>,
  calls: RecordedCall[],
): GithubClient {
  const fetchImpl: typeof fetch = async (input, init) => {
    const method = init?.method ?? "GET";
    const url = String(input);
    calls.push({
      method,
      url,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    const h = handlers.find((x) => x.match.test(url) && (!x.method || x.method === method));
    if (!h) return new Response("nf", { status: 404 });
    return new Response(h.body !== undefined ? JSON.stringify(h.body) : null, {
      status: h.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  };
  return new GithubClient({ credentials: { token: "tok" }, fetch: fetchImpl });
}

function ctx(writeEnabled: boolean): TicketContext {
  return { tenantId: "t1", credentials: { token: "tok" }, writeEnabled };
}

describe("GithubProvider integration", () => {
  it("getIssue -> normalized ticket", async () => {
    const calls: RecordedCall[] = [];
    const client = mockClient([{ match: /issues\/42$/, body: loadFixture("issue.json") }], calls);
    const provider = new GithubProvider({ clientFactory: () => client });
    const t = await provider.getIssue("acme/widgets#42", ctx(false));
    expect(t?.key).toBe("#42");
    expect(calls[0].method).toBe("GET");
    expect(calls[0].url).toContain("/repos/acme/widgets/issues/42");
  });

  it("postComment fails when writeEnabled=false", async () => {
    const provider = new GithubProvider({ clientFactory: () => mockClient([], []) });
    const body = markdownToMdx("hi");
    expect(provider.postComment("acme/widgets#42", body, ctx(false))).rejects.toBeInstanceOf(TicketWriteDisabledError);
  });

  it("postComment sends markdown body when writeEnabled=true", async () => {
    const calls: RecordedCall[] = [];
    const client = mockClient(
      [
        {
          match: /issues\/42\/comments$/,
          method: "POST",
          body: {
            id: 9999,
            body: "**hi**",
            user: { id: 1, login: "me" },
            created_at: "2024-01-01T00:00:00Z",
            updated_at: "2024-01-01T00:00:00Z",
          },
        },
      ],
      calls,
    );
    const provider = new GithubProvider({ clientFactory: () => client });
    const comment = await provider.postComment("acme/widgets#42", markdownToMdx("**hi**"), ctx(true));
    expect(comment.id).toBe("9999");
    expect(calls[0].method).toBe("POST");
    expect((calls[0].body as { body: string }).body).toContain("**hi**");
  });

  it("updateIssue sends only provided fields", async () => {
    const calls: RecordedCall[] = [];
    const client = mockClient([{ match: /issues\/42$/, method: "PATCH", body: loadFixture("issue.json") }], calls);
    const provider = new GithubProvider({ clientFactory: () => client });
    await provider.updateIssue(
      "acme/widgets#42",
      { title: "new title", labels: ["triage"], assigneeId: null },
      ctx(true),
    );
    const body = calls[0].body as Record<string, unknown>;
    expect(body.title).toBe("new title");
    expect(body.labels).toEqual(["triage"]);
    expect(body.assignees).toEqual([]);
    expect(body).not.toHaveProperty("body");
  });

  it("transitionStatus maps done -> closed+completed", async () => {
    const calls: RecordedCall[] = [];
    const client = mockClient([{ match: /issues\/42$/, method: "PATCH", body: loadFixture("issue.json") }], calls);
    const provider = new GithubProvider({ clientFactory: () => client });
    await provider.transitionStatus("acme/widgets#42", "done", ctx(true));
    const body = calls[0].body as Record<string, unknown>;
    expect(body.state).toBe("closed");
    expect(body.state_reason).toBe("completed");
  });

  it("transitionStatus maps cancelled -> closed+not_planned", async () => {
    const calls: RecordedCall[] = [];
    const client = mockClient([{ match: /issues\/42$/, method: "PATCH", body: loadFixture("issue.json") }], calls);
    const provider = new GithubProvider({ clientFactory: () => client });
    await provider.transitionStatus("acme/widgets#42", "cancelled", ctx(true));
    const body = calls[0].body as Record<string, unknown>;
    expect(body.state_reason).toBe("not_planned");
  });

  it("transitionStatus rejects unknown targets", async () => {
    const provider = new GithubProvider({ clientFactory: () => mockClient([], []) });
    expect(provider.transitionStatus("acme/widgets#42", "on_hold", ctx(true))).rejects.toThrow(
      /unsupported transition/,
    );
  });

  it("addLabel + removeLabel hit the labels sub-resource", async () => {
    const calls: RecordedCall[] = [];
    const client = mockClient(
      [
        { match: /labels$/, method: "POST", body: [{ name: "triage" }] },
        { match: /labels\/triage/, method: "DELETE", status: 200, body: [] },
      ],
      calls,
    );
    const provider = new GithubProvider({ clientFactory: () => client });
    await provider.addLabel("acme/widgets#42", "triage", ctx(true));
    await provider.removeLabel("acme/widgets#42", "triage", ctx(true));
    expect(calls[0].method).toBe("POST");
    expect((calls[0].body as { labels: string[] }).labels).toEqual(["triage"]);
    expect(calls[1].method).toBe("DELETE");
    expect(calls[1].url).toContain("labels/triage");
  });

  it("searchIssues forwards query + normalizes items", async () => {
    const calls: RecordedCall[] = [];
    const client = mockClient([{ match: /\/search\/issues/, body: { items: [loadFixture("issue.json")] } }], calls);
    const provider = new GithubProvider({ clientFactory: () => client });
    const { tickets } = await provider.searchIssues({ text: "csv", limit: 10 }, ctx(false));
    expect(tickets.length).toBe(1);
    expect(tickets[0].key).toBe("#42");
    expect(calls[0].url).toContain("/search/issues");
    expect(calls[0].url).toContain("per_page=10");
  });

  it("listComments paginates and normalizes", async () => {
    const calls: RecordedCall[] = [];
    const client = mockClient([{ match: /issues\/42\/comments/, body: [loadFixture("comment.json")] }], calls);
    const provider = new GithubProvider({ clientFactory: () => client });
    const comments = await provider.listComments("acme/widgets#42", ctx(false));
    expect(comments.length).toBe(1);
    expect(comments[0].id).toBe("9001");
    expect(comments[0].ticketId).toBe("acme/widgets#42");
    expect(calls[0].url).toContain("/repos/acme/widgets/issues/42/comments");
  });

  it("listActivity maps event kinds", async () => {
    const calls: RecordedCall[] = [];
    const client = mockClient(
      [
        {
          match: /issues\/42\/events/,
          body: [
            {
              id: 1,
              event: "closed",
              actor: { id: 22, login: "bob" },
              created_at: "2024-01-01T00:00:00Z",
            },
            {
              id: 2,
              event: "labeled",
              actor: { id: 22, login: "bob" },
              created_at: "2024-01-01T00:01:00Z",
              label: { name: "triage" },
            },
            {
              id: 3,
              event: "assigned",
              actor: { id: 22, login: "bob" },
              created_at: "2024-01-01T00:02:00Z",
              assignee: { id: 99, login: "alice" },
            },
          ],
        },
      ],
      calls,
    );
    const provider = new GithubProvider({ clientFactory: () => client });
    const events = await provider.listActivity("acme/widgets#42", ctx(false));
    expect(events.length).toBe(3);
    expect(events[0].kind).toBe("transitioned");
    expect(events[1].kind).toBe("labeled");
    expect(events[1].changes.label).toEqual({ old: null, new: "triage" });
    expect(events[2].kind).toBe("assigned");
    expect(events[2].changes.assignee).toEqual({ old: null, new: "alice" });
  });

  it("testConnection returns ok on /user 200", async () => {
    const client = mockClient([{ match: /\/user$/, body: { login: "me" } }], []);
    const provider = new GithubProvider({ clientFactory: () => client });
    const res = await provider.testConnection(ctx(false));
    expect(res.ok).toBe(true);
  });

  it("testConnection returns ok=false on failure", async () => {
    const fetchImpl: typeof fetch = async () => new Response("no", { status: 500 });
    const failing = new GithubClient({ credentials: { token: "tok" }, fetch: fetchImpl });
    const provider = new GithubProvider({ clientFactory: () => failing });
    const res = await provider.testConnection(ctx(false));
    expect(res.ok).toBe(false);
    expect(res.error).toBeDefined();
  });
});
