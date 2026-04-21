import { describe, expect, it } from "bun:test";
import { GithubClient, parseLinkNext } from "../client.js";

function mockResponse(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

describe("GithubClient", () => {
  it("refuses construction without a token", () => {
    expect(() => new GithubClient({ credentials: {} })).toThrow(/token or credentials.bearer/);
  });

  it("sets auth + user-agent + api version headers on every request", async () => {
    let seenHeaders: Headers | null = null;
    const client = new GithubClient({
      credentials: { token: "tok" },
      fetch: async (_url, init) => {
        seenHeaders = new Headers(init?.headers);
        return mockResponse({ ok: true }, { headers: { "x-ratelimit-remaining": "4900" } });
      },
    });
    await client.get("/user");
    expect(seenHeaders!.get("authorization")).toBe("Bearer tok");
    expect(seenHeaders!.get("user-agent")).toContain("ark-ticket-github");
    expect(seenHeaders!.get("x-github-api-version")).toBe("2022-11-28");
  });

  it("extracts next cursor from Link header", () => {
    expect(
      parseLinkNext(
        '<https://api.github.com/resource?page=2>; rel="next", <https://api.github.com/resource?page=5>; rel="last"',
      ),
    ).toBe("https://api.github.com/resource?page=2");
    expect(parseLinkNext(null)).toBeNull();
    expect(parseLinkNext('<https://x>; rel="last"')).toBeNull();
  });

  it("paginates via Link header until rel=next disappears", async () => {
    let call = 0;
    const client = new GithubClient({
      credentials: { token: "tok" },
      fetch: async () => {
        call++;
        if (call === 1) {
          return mockResponse([{ id: 1 }, { id: 2 }], {
            headers: {
              link: '<https://api.github.com/next?page=2>; rel="next"',
              "x-ratelimit-remaining": "99",
            },
          });
        }
        return mockResponse([{ id: 3 }], { headers: { "x-ratelimit-remaining": "98" } });
      },
    });
    const all = await client.paginate<{ id: number }>("/repos/a/b/issues/1/comments");
    expect(all.map((i) => i.id)).toEqual([1, 2, 3]);
    expect(call).toBe(2);
  });

  it("retries once on secondary rate limit (403 + retry-after)", async () => {
    let call = 0;
    let slept = 0;
    const client = new GithubClient({
      credentials: { token: "tok" },
      fetch: async () => {
        call++;
        if (call === 1) {
          return new Response("slow down", {
            status: 403,
            headers: { "retry-after": "2", "x-ratelimit-remaining": "0" },
          });
        }
        return mockResponse({ ok: true });
      },
      sleep: async (ms) => {
        slept = ms;
      },
    });
    const res = await client.get<{ ok: boolean }>("/user");
    expect(res.data.ok).toBe(true);
    expect(call).toBe(2);
    expect(slept).toBe(2000);
  });

  it("backs off preemptively when remaining < 5", async () => {
    const resetAt = Math.floor(Date.now() / 1000) + 1; // 1s in the future
    let slept = 0;
    const client = new GithubClient({
      credentials: { token: "tok" },
      fetch: async () =>
        mockResponse(
          { ok: true },
          {
            headers: {
              "x-ratelimit-remaining": "2",
              "x-ratelimit-reset": String(resetAt),
            },
          },
        ),
      sleep: async (ms) => {
        slept = ms;
      },
    });
    await client.get("/user");
    expect(slept).toBeGreaterThan(0);
    expect(slept).toBeLessThan(60_000);
  });

  it("returns null data on 404 without throwing", async () => {
    const client = new GithubClient({
      credentials: { token: "tok" },
      fetch: async () => new Response("", { status: 404 }),
    });
    const res = await client.get<unknown>("/missing");
    expect(res.status).toBe(404);
    expect(res.data).toBeNull();
  });

  it("honours custom baseUrl for Enterprise", async () => {
    let seenUrl = "";
    const client = new GithubClient({
      credentials: { token: "tok", baseUrl: "https://ghe.internal/api/v3" },
      fetch: async (url) => {
        seenUrl = String(url);
        return mockResponse({ ok: true });
      },
    });
    await client.get("/user");
    expect(seenUrl).toBe("https://ghe.internal/api/v3/user");
  });
});
