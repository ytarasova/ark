import { describe, it, expect, beforeEach } from "bun:test";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { JiraProvider } from "../index.js";
import { resetJiraRateLimiter, type FetchLike } from "../client.js";
import { TicketWriteDisabledError, type TicketContext } from "../../../types.js";
import { markdownToMdx } from "../../../richtext/markdown.js";
import type { AdfDoc } from "../../../richtext/adf.js";

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

function writeCtx(overrides: Partial<TicketContext> = {}): TicketContext {
  return {
    tenantId: "t1",
    credentials: { baseUrl: "https://acme.atlassian.net", token: "tok" },
    writeEnabled: true,
    ...overrides,
  };
}

describe("JiraProvider write gating", () => {
  it("throws TicketWriteDisabledError when ctx.writeEnabled is false", async () => {
    const provider = new JiraProvider({ fetchImpl: async () => jsonResponse({}) });
    const ctx = writeCtx({ writeEnabled: false });
    await expect(provider.postComment("PROJ-1", markdownToMdx("hi"), ctx)).rejects.toBeInstanceOf(
      TicketWriteDisabledError,
    );
    await expect(provider.updateIssue("PROJ-1", { title: "x" }, ctx)).rejects.toBeInstanceOf(TicketWriteDisabledError);
    await expect(provider.transitionStatus("PROJ-1", "Done", ctx)).rejects.toBeInstanceOf(TicketWriteDisabledError);
    await expect(provider.addLabel("PROJ-1", "l", ctx)).rejects.toBeInstanceOf(TicketWriteDisabledError);
    await expect(provider.removeLabel("PROJ-1", "l", ctx)).rejects.toBeInstanceOf(TicketWriteDisabledError);
  });
});

describe("JiraProvider.postComment", () => {
  beforeEach(() => {
    resetJiraRateLimiter();
  });

  it("converts RichText (MDX) -> ADF and posts { body: adfDoc }", async () => {
    const captured: { url?: string; body?: unknown } = {};
    const fetchImpl: FetchLike = async (url, init) => {
      captured.url = String(url);
      captured.body = JSON.parse(init?.body as string);
      return jsonResponse(load("comment.json"));
    };
    const provider = new JiraProvider({ fetchImpl, clientOptions: { sleep: async () => {} } });
    const mdx = markdownToMdx("Hello **world**");
    const result = await provider.postComment("PROJ-1", mdx, writeCtx());

    expect(captured.url).toContain("/rest/api/3/issue/PROJ-1/comment");
    const body = captured.body as { body: AdfDoc };
    expect(body.body.type).toBe("doc");
    expect(body.body.version).toBe(1);
    expect(Array.isArray(body.body.content)).toBe(true);
    // The ADF should carry at least one paragraph with a strong-marked 'world'.
    const serialized = JSON.stringify(body.body);
    expect(serialized).toContain("paragraph");
    expect(serialized).toContain('"type":"strong"');
    expect(serialized).toContain("world");
    expect(result.id).toBe("70001");
  });
});

describe("JiraProvider.updateIssue", () => {
  it("sends {fields:{...}} with ADF-encoded description and Jira-shaped assignee/priority/parent", async () => {
    const captured: unknown[] = [];
    const fetchImpl: FetchLike = async (_url, init) => {
      if (init?.method === "PUT") {
        captured.push(JSON.parse(init.body as string));
        return new Response("", { status: 204 });
      }
      // GET after PUT for round-trip snapshot.
      return jsonResponse(load("story.json"));
    };
    const provider = new JiraProvider({ fetchImpl, clientOptions: { sleep: async () => {} } });
    await provider.updateIssue(
      "PROJ-2",
      {
        title: "Renamed",
        body: markdownToMdx("new body"),
        assigneeId: "acc-xyz",
        priority: "High",
        labels: ["a", "b"],
        parentId: "PROJ-1",
      },
      writeCtx(),
    );
    const body = captured[0] as { fields: Record<string, unknown> };
    expect(body.fields.summary).toBe("Renamed");
    expect((body.fields.description as AdfDoc).type).toBe("doc");
    expect(body.fields.assignee).toEqual({ accountId: "acc-xyz" });
    expect(body.fields.priority).toEqual({ name: "High" });
    expect(body.fields.labels).toEqual(["a", "b"]);
    expect(body.fields.parent).toEqual({ id: "PROJ-1" });
  });

  it("sends null to clear assignee/priority/parent", async () => {
    const captured: unknown[] = [];
    const fetchImpl: FetchLike = async (_url, init) => {
      if (init?.method === "PUT") {
        captured.push(JSON.parse(init.body as string));
        return new Response("", { status: 204 });
      }
      return jsonResponse(load("story.json"));
    };
    const provider = new JiraProvider({ fetchImpl, clientOptions: { sleep: async () => {} } });
    await provider.updateIssue("PROJ-2", { assigneeId: null, priority: null, parentId: null }, writeCtx());
    const body = captured[0] as { fields: Record<string, unknown> };
    expect(body.fields.assignee).toBeNull();
    expect(body.fields.priority).toBeNull();
    expect(body.fields.parent).toBeNull();
  });
});

describe("JiraProvider.transitionStatus", () => {
  it("looks up the transition id and POSTs it", async () => {
    const captured: { url?: string; body?: unknown; method?: string }[] = [];
    const fetchImpl: FetchLike = async (url, init) => {
      captured.push({
        url: String(url),
        method: init?.method,
        body: init?.body ? JSON.parse(init.body as string) : undefined,
      });
      if (String(url).includes("/transitions") && init?.method === "GET") {
        return jsonResponse({
          transitions: [
            { id: "11", name: "Start work", to: { name: "In Progress" } },
            { id: "21", name: "Done", to: { name: "Done" } },
          ],
        });
      }
      if (String(url).includes("/transitions") && init?.method === "POST") {
        return new Response("", { status: 204 });
      }
      return jsonResponse(load("story.json"));
    };
    const provider = new JiraProvider({ fetchImpl, clientOptions: { sleep: async () => {} } });
    await provider.transitionStatus("PROJ-2", "Done", writeCtx());
    const post = captured.find((c) => c.method === "POST" && c.url?.includes("/transitions"));
    expect(post?.body).toEqual({ transition: { id: "21" } });
  });

  it("throws when no matching transition exists", async () => {
    const fetchImpl: FetchLike = async () => jsonResponse({ transitions: [{ id: "11", name: "Start" }] });
    const provider = new JiraProvider({ fetchImpl, clientOptions: { sleep: async () => {} } });
    await expect(provider.transitionStatus("PROJ-2", "Nonexistent", writeCtx())).rejects.toThrow(/no transition/);
  });
});

describe("JiraProvider.addLabel / removeLabel", () => {
  it("addLabel dedupes against existing labels", async () => {
    const puts: unknown[] = [];
    const fetchImpl: FetchLike = async (_url, init) => {
      if (init?.method === "GET") return jsonResponse({ id: "1", key: "PROJ-1", fields: { labels: ["a"] } });
      if (init?.method === "PUT") {
        puts.push(JSON.parse(init.body as string));
        return new Response("", { status: 204 });
      }
      return jsonResponse({});
    };
    const provider = new JiraProvider({ fetchImpl, clientOptions: { sleep: async () => {} } });
    await provider.addLabel("PROJ-1", "a", writeCtx()); // already present
    expect(puts).toHaveLength(0);
    await provider.addLabel("PROJ-1", "b", writeCtx());
    expect((puts[0] as { fields: { labels: string[] } }).fields.labels).toEqual(["a", "b"]);
  });

  it("removeLabel is a no-op when the label is missing", async () => {
    const puts: unknown[] = [];
    const fetchImpl: FetchLike = async (_url, init) => {
      if (init?.method === "GET") return jsonResponse({ id: "1", key: "PROJ-1", fields: { labels: ["a"] } });
      if (init?.method === "PUT") {
        puts.push(JSON.parse(init.body as string));
        return new Response("", { status: 204 });
      }
      return jsonResponse({});
    };
    const provider = new JiraProvider({ fetchImpl, clientOptions: { sleep: async () => {} } });
    await provider.removeLabel("PROJ-1", "missing", writeCtx());
    expect(puts).toHaveLength(0);
    await provider.removeLabel("PROJ-1", "a", writeCtx());
    expect((puts[0] as { fields: { labels: string[] } }).fields.labels).toEqual([]);
  });
});
