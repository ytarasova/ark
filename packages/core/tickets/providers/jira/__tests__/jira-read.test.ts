import { describe, it, expect, beforeEach } from "bun:test";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { JiraProvider } from "../index.js";
import { resetJiraRateLimiter, type FetchLike } from "../client.js";
import type { TicketContext } from "../../../types.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");

function load<T>(name: string): T {
  return JSON.parse(readFileSync(join(FIXTURES, name), "utf-8")) as T;
}

function jsonResponse(body: unknown, init?: { status?: number }): Response {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: { "content-type": "application/json" },
  });
}

function ctx(overrides: Partial<TicketContext> = {}): TicketContext {
  return {
    tenantId: "t1",
    credentials: {
      baseUrl: "https://acme.atlassian.net",
      username: "y@acme.io",
      token: "tok",
    },
    writeEnabled: false,
    ...overrides,
  };
}

describe("JiraProvider read paths", () => {
  beforeEach(() => {
    resetJiraRateLimiter();
  });

  it("getIssue fetches /rest/api/3/issue/KEY and normalises", async () => {
    const issue = load<object>("story.json");
    const calls: string[] = [];
    const fetchImpl: FetchLike = async (url) => {
      calls.push(String(url));
      return jsonResponse(issue);
    };
    const provider = new JiraProvider({ fetchImpl, clientOptions: { sleep: async () => {} } });
    const n = await provider.getIssue("PROJ-2", ctx());
    expect(n).not.toBeNull();
    expect(n!.key).toBe("PROJ-2");
    expect(calls[0]).toContain("/rest/api/3/issue/PROJ-2");
    expect(calls[0]).toContain("fields=*all");
    expect(calls[0]).toContain("expand=renderedFields%2Cchangelog");
  });

  it("getIssue returns null on 404", async () => {
    const fetchImpl: FetchLike = async () => new Response("Not found", { status: 404, statusText: "Not Found" });
    const provider = new JiraProvider({ fetchImpl, clientOptions: { sleep: async () => {} } });
    expect(await provider.getIssue("NOPE-1", ctx())).toBeNull();
  });

  it("searchIssues POSTs JQL and paginates via cursor", async () => {
    const issue = load<object>("story.json");
    const bodies: unknown[] = [];
    const fetchImpl: FetchLike = async (_url, init) => {
      bodies.push(JSON.parse(init?.body as string));
      return jsonResponse({
        issues: [issue],
        startAt: 0,
        maxResults: 1,
        total: 2,
      });
    };
    const provider = new JiraProvider({ fetchImpl, clientOptions: { sleep: async () => {} } });
    const page = await provider.searchIssues({ statusCategories: ["in_progress"], limit: 1 }, ctx());
    expect(page.tickets).toHaveLength(1);
    expect(page.cursor).toBe("1");
    const body = bodies[0] as { jql: string; startAt: number; maxResults: number };
    expect(body.jql).toContain("statusCategory in");
    expect(body.jql).toContain("ORDER BY updated DESC");
    expect(body.maxResults).toBe(1);
    expect(body.startAt).toBe(0);
  });

  it("searchIssues returns no cursor when total is exhausted", async () => {
    const issue = load<object>("story.json");
    const fetchImpl: FetchLike = async () => jsonResponse({ issues: [issue], startAt: 0, maxResults: 50, total: 1 });
    const provider = new JiraProvider({ fetchImpl, clientOptions: { sleep: async () => {} } });
    const page = await provider.searchIssues({}, ctx());
    expect(page.cursor).toBeUndefined();
  });

  it("listComments normalises each comment", async () => {
    const comment = load<object>("comment.json");
    const fetchImpl: FetchLike = async () =>
      jsonResponse({ comments: [comment, { ...(comment as object), id: "70002" }] });
    const provider = new JiraProvider({ fetchImpl, clientOptions: { sleep: async () => {} } });
    const comments = await provider.listComments("10040", ctx());
    expect(comments).toHaveLength(2);
    expect(comments[0].ticketId).toBe("10040");
  });

  it("listActivity derives from changelog.histories", async () => {
    const issue = load<object>("bug-codeblock.json");
    const fetchImpl: FetchLike = async () => jsonResponse(issue);
    const provider = new JiraProvider({ fetchImpl, clientOptions: { sleep: async () => {} } });
    const activity = await provider.listActivity("PROJ-5", ctx());
    expect(activity).toHaveLength(2);
    expect(activity[0].kind).toBe("transitioned");
  });

  it("testConnection returns ok when /myself succeeds", async () => {
    const fetchImpl: FetchLike = async () => jsonResponse({ accountId: "acc" });
    const provider = new JiraProvider({ fetchImpl, clientOptions: { sleep: async () => {} } });
    const result = await provider.testConnection(ctx());
    expect(result.ok).toBe(true);
  });

  it("testConnection returns ok=false on auth failure", async () => {
    const fetchImpl: FetchLike = async () => new Response("unauthorised", { status: 401, statusText: "Unauthorized" });
    const provider = new JiraProvider({ fetchImpl, clientOptions: { sleep: async () => {} } });
    const result = await provider.testConnection(ctx());
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/401/);
  });
});
