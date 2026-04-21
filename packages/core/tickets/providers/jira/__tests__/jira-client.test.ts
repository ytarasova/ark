import { describe, it, expect, beforeEach } from "bun:test";
import { JiraApiError, JiraClient, resetJiraRateLimiter, type FetchLike } from "../client.js";

function jsonResponse(body: unknown, init?: { status?: number; headers?: Record<string, string> }): Response {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
}

describe("JiraClient", () => {
  beforeEach(() => {
    resetJiraRateLimiter();
  });

  it("builds Basic auth from username + token", () => {
    const client = new JiraClient({
      credentials: { baseUrl: "https://acme.atlassian.net", username: "y@acme.io", token: "api-tok" },
    });
    const expected = "Basic " + Buffer.from("y@acme.io:api-tok").toString("base64");
    expect(client.authHeader()).toBe(expected);
  });

  it("builds Bearer auth from bearer or token-only", () => {
    const client = new JiraClient({
      credentials: { baseUrl: "https://acme.atlassian.net", bearer: "oauth-123" },
    });
    expect(client.authHeader()).toBe("Bearer oauth-123");

    const client2 = new JiraClient({
      credentials: { baseUrl: "https://acme.atlassian.net", token: "pat-456" },
    });
    expect(client2.authHeader()).toBe("Bearer pat-456");
  });

  it("throws when no credentials are present", () => {
    const client = new JiraClient({ credentials: { baseUrl: "https://acme.atlassian.net" } });
    expect(() => client.authHeader()).toThrow(/no credentials/);
  });

  it("composes URL with query params", () => {
    const client = new JiraClient({
      credentials: { baseUrl: "https://acme.atlassian.net/", token: "t" },
    });
    expect(client.buildUrl("/rest/api/3/issue/PROJ-1", { fields: "*all", expand: "renderedFields" })).toBe(
      "https://acme.atlassian.net/rest/api/3/issue/PROJ-1?fields=*all&expand=renderedFields",
    );
  });

  it("retries on 429 with Retry-After and succeeds", async () => {
    const calls: string[] = [];
    const sleeps: number[] = [];
    const fetchImpl: FetchLike = async (url) => {
      calls.push(String(url));
      if (calls.length < 3) {
        return new Response("", { status: 429, headers: { "retry-after": "1" } });
      }
      return jsonResponse({ ok: true });
    };
    const client = new JiraClient({
      credentials: { baseUrl: "https://acme.atlassian.net", token: "t" },
      fetchImpl,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      maxRetries: 5,
      backoffBaseMs: 10,
    });
    const result = await client.request<{ ok: boolean }>({ method: "GET", path: "/rest/api/3/myself" });
    expect(result).toEqual({ ok: true });
    expect(calls).toHaveLength(3);
    // two retry sleeps at 1000 ms each (Retry-After: 1)
    expect(sleeps.filter((s) => s === 1000)).toHaveLength(2);
  });

  it("falls back to exponential backoff when Retry-After is missing", async () => {
    const sleeps: number[] = [];
    let attempt = 0;
    const fetchImpl: FetchLike = async () => {
      attempt += 1;
      if (attempt <= 2) return new Response("", { status: 429 });
      return jsonResponse({ ok: true });
    };
    const client = new JiraClient({
      credentials: { baseUrl: "https://acme.atlassian.net", token: "t" },
      fetchImpl,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      maxRetries: 3,
      backoffBaseMs: 100,
    });
    await client.request({ method: "GET", path: "/rest/api/3/myself" });
    // two retries: 100, 200 (exponential)
    expect(sleeps.filter((s) => s === 100 || s === 200)).toHaveLength(2);
  });

  it("throws JiraApiError on non-429 failure", async () => {
    const fetchImpl: FetchLike = async () => new Response("bad", { status: 500, statusText: "Server Error" });
    const client = new JiraClient({
      credentials: { baseUrl: "https://acme.atlassian.net", token: "t" },
      fetchImpl,
      sleep: async () => {},
    });
    await expect(client.request({ method: "GET", path: "/rest/api/3/myself" })).rejects.toBeInstanceOf(JiraApiError);
  });

  it("sets Content-Type on requests with a body", async () => {
    let seenHeaders: Record<string, string> | null = null;
    const fetchImpl: FetchLike = async (_url, init) => {
      seenHeaders = init?.headers as Record<string, string>;
      return jsonResponse({});
    };
    const client = new JiraClient({
      credentials: { baseUrl: "https://acme.atlassian.net", token: "t" },
      fetchImpl,
      sleep: async () => {},
    });
    await client.request({ method: "POST", path: "/rest/api/3/search", body: { jql: "x" } });
    expect(seenHeaders?.["Content-Type"]).toBe("application/json");
  });
});
