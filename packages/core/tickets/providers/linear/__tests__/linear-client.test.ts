import { describe, expect, it } from "bun:test";
import { LinearClient } from "../client.js";

function mockResponse(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

describe("LinearClient", () => {
  it("refuses construction without a token", () => {
    expect(() => new LinearClient({ credentials: {} })).toThrow(/token is required/);
  });

  it("uses raw key as Authorization (no Bearer prefix)", async () => {
    let auth = "";
    const client = new LinearClient({
      credentials: { token: "lin_api_abc" },
      fetch: async (_url, init) => {
        auth = new Headers(init?.headers).get("authorization") ?? "";
        return mockResponse({ data: { ok: true } });
      },
    });
    await client.request("{ ok }");
    expect(auth).toBe("lin_api_abc");
    expect(auth.startsWith("Bearer ")).toBe(false);
  });

  it("throws on GraphQL errors", async () => {
    const client = new LinearClient({
      credentials: { token: "k" },
      fetch: async () => mockResponse({ errors: [{ message: "bad query" }], data: null }),
    });
    expect(client.request("{ ok }")).rejects.toThrow(/bad query/);
  });

  it("retries once on 429 with Retry-After", async () => {
    let call = 0;
    let slept = 0;
    const client = new LinearClient({
      credentials: { token: "k" },
      fetch: async () => {
        call++;
        if (call === 1) {
          return new Response("too many", {
            status: 429,
            headers: { "retry-after": "3" },
          });
        }
        return mockResponse({ data: { ok: true } });
      },
      sleep: async (ms) => {
        slept = ms;
      },
    });
    const res = await client.request<{ ok: boolean }>("{ ok }");
    expect(res.data.ok).toBe(true);
    expect(slept).toBe(3000);
  });

  it("paginates over a connection", async () => {
    let call = 0;
    const client = new LinearClient({
      credentials: { token: "k" },
      fetch: async () => {
        call++;
        if (call === 1) {
          return mockResponse({
            data: {
              thing: {
                nodes: [{ id: "1" }, { id: "2" }],
                pageInfo: { hasNextPage: true, endCursor: "cur-1" },
              },
            },
          });
        }
        return mockResponse({
          data: { thing: { nodes: [{ id: "3" }], pageInfo: { hasNextPage: false, endCursor: null } } },
        });
      },
    });
    const items = await client.paginate<
      { id: string },
      { thing: { nodes: Array<{ id: string }>; pageInfo: { hasNextPage: boolean; endCursor: string | null } } }
    >("q", {}, (d) => d.thing);
    expect(items.map((i) => i.id)).toEqual(["1", "2", "3"]);
    expect(call).toBe(2);
  });

  it("backs off when rate-limit remaining < 10", async () => {
    let slept = 0;
    const resetAt = Math.floor(Date.now() / 1000) + 2;
    const client = new LinearClient({
      credentials: { token: "k" },
      fetch: async () =>
        mockResponse(
          { data: { ok: true } },
          { headers: { "x-ratelimit-remaining": "2", "x-ratelimit-reset": String(resetAt) } },
        ),
      sleep: async (ms) => {
        slept = ms;
      },
    });
    await client.request("{ ok }");
    expect(slept).toBeGreaterThan(0);
  });
});
