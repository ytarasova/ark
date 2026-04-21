import { describe, expect, it } from "bun:test";
import { BitbucketClient } from "../client.js";

function mockResponse(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

describe("BitbucketClient", () => {
  it("requires some form of credentials", () => {
    expect(() => new BitbucketClient({ credentials: {} })).toThrow(/bearer, or username\+password, or token/);
  });

  it("uses Basic auth when username+password present", async () => {
    let auth = "";
    const client = new BitbucketClient({
      credentials: { username: "alice", password: "app-pass" },
      fetch: async (_url, init) => {
        auth = new Headers(init?.headers).get("authorization") ?? "";
        return mockResponse({ ok: true });
      },
    });
    await client.get("/user");
    expect(auth.startsWith("Basic ")).toBe(true);
    const decoded = Buffer.from(auth.slice(6), "base64").toString("utf8");
    expect(decoded).toBe("alice:app-pass");
  });

  it("uses Bearer auth when bearer token present", async () => {
    let auth = "";
    const client = new BitbucketClient({
      credentials: { bearer: "oauth-token" },
      fetch: async (_url, init) => {
        auth = new Headers(init?.headers).get("authorization") ?? "";
        return mockResponse({});
      },
    });
    await client.get("/user");
    expect(auth).toBe("Bearer oauth-token");
  });

  it("paginates by following `next` URLs", async () => {
    let call = 0;
    const client = new BitbucketClient({
      credentials: { bearer: "t" },
      fetch: async () => {
        call++;
        if (call === 1) {
          return mockResponse({ values: [{ id: 1 }, { id: 2 }], next: "https://api.bitbucket.org/2.0/next?page=2" });
        }
        return mockResponse({ values: [{ id: 3 }] });
      },
    });
    const out = await client.paginate<{ id: number }>("/repositories/a/b/issues/1/comments");
    expect(out.map((x) => x.id)).toEqual([1, 2, 3]);
    expect(call).toBe(2);
  });

  it("retries once on 429 with Retry-After", async () => {
    let call = 0;
    let slept = 0;
    const client = new BitbucketClient({
      credentials: { bearer: "t" },
      fetch: async () => {
        call++;
        if (call === 1) return new Response("slow", { status: 429, headers: { "retry-after": "2" } });
        return mockResponse({ ok: true });
      },
      sleep: async (ms) => {
        slept = ms;
      },
    });
    await client.get("/user");
    expect(call).toBe(2);
    expect(slept).toBe(2000);
  });

  it("returns null data on 404 without throwing", async () => {
    const client = new BitbucketClient({
      credentials: { bearer: "t" },
      fetch: async () => new Response("", { status: 404 }),
    });
    const res = await client.get<unknown>("/missing");
    expect(res.status).toBe(404);
    expect(res.data).toBeNull();
  });

  it("honours credentials.baseUrl for self-hosted / staging", async () => {
    let seenUrl = "";
    const client = new BitbucketClient({
      credentials: { bearer: "t", baseUrl: "https://bb.internal/api/2.0" },
      fetch: async (url) => {
        seenUrl = String(url);
        return mockResponse({});
      },
    });
    await client.get("/user");
    expect(seenUrl).toBe("https://bb.internal/api/2.0/user");
  });
});
