/**
 * GitHub REST v3 HTTP client.
 *
 * Thin wrapper over `fetch` that handles:
 *   - Auth (bearer token / PAT / installation token)
 *   - `Link` header pagination (returns next cursor)
 *   - Primary rate limit: back off preemptively when `X-RateLimit-Remaining < 5`
 *   - Secondary rate limit: 403 + `retry-after` header -> sleep + retry once
 *   - Base URL override for GitHub Enterprise (`credentials.baseUrl`)
 *
 * The client is intentionally stateless -- a fresh instance per request is
 * fine. Per-tenant config flows through `TicketCredentials`, never an
 * ambient global.
 */

import type { TicketCredentials } from "../../types.js";

export interface GithubClientOptions {
  credentials: TicketCredentials;
  /** Inject fetch for tests. Defaults to globalThis.fetch. */
  fetch?: typeof fetch;
  /** Sleep implementation (ms). Defaults to a real setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  /** User-Agent override. */
  userAgent?: string;
}

export interface GithubResponse<T> {
  data: T;
  /** Next-page cursor (a full URL) extracted from the `Link` header, if any. */
  nextCursor: string | null;
  /** Remaining primary-rate-limit budget at time of response. */
  remaining: number;
  /** Epoch seconds when the primary limit resets. */
  reset: number;
  headers: Headers;
  status: number;
}

const DEFAULT_BASE = "https://api.github.com";

export class GithubClient {
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly baseUrl: string;
  private readonly authHeader: string;
  private readonly userAgent: string;

  constructor(opts: GithubClientOptions) {
    this.fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.baseUrl = (opts.credentials.baseUrl ?? DEFAULT_BASE).replace(/\/+$/, "");
    const token = opts.credentials.bearer ?? opts.credentials.token ?? "";
    if (!token) throw new Error("GithubClient: credentials.token or credentials.bearer is required");
    this.authHeader = `Bearer ${token}`;
    this.userAgent = opts.userAgent ?? "ark-ticket-github/1.0";
  }

  async get<T>(pathOrUrl: string, init?: RequestInit): Promise<GithubResponse<T>> {
    return this.request<T>("GET", pathOrUrl, init);
  }

  async post<T>(pathOrUrl: string, body: unknown): Promise<GithubResponse<T>> {
    return this.request<T>("POST", pathOrUrl, {
      body: JSON.stringify(body),
    });
  }

  async patch<T>(pathOrUrl: string, body: unknown): Promise<GithubResponse<T>> {
    return this.request<T>("PATCH", pathOrUrl, {
      body: JSON.stringify(body),
    });
  }

  async put<T>(pathOrUrl: string, body: unknown): Promise<GithubResponse<T>> {
    return this.request<T>("PUT", pathOrUrl, {
      body: JSON.stringify(body),
    });
  }

  async delete<T>(pathOrUrl: string): Promise<GithubResponse<T>> {
    return this.request<T>("DELETE", pathOrUrl);
  }

  /** Paginate a GET until exhausted. Returns flattened list of items. */
  async paginate<T>(path: string, pageSize = 100): Promise<T[]> {
    const sep = path.includes("?") ? "&" : "?";
    let url = `${path}${sep}per_page=${pageSize}`;
    const out: T[] = [];
    for (;;) {
      const res = await this.get<T[]>(url);
      if (Array.isArray(res.data)) out.push(...res.data);
      if (!res.nextCursor) break;
      url = res.nextCursor;
    }
    return out;
  }

  private async request<T>(method: string, pathOrUrl: string, init?: RequestInit): Promise<GithubResponse<T>> {
    const url = pathOrUrl.startsWith("http") ? pathOrUrl : `${this.baseUrl}${pathOrUrl}`;
    const headers: Record<string, string> = {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      authorization: this.authHeader,
      "user-agent": this.userAgent,
      ...(init?.body ? { "content-type": "application/json" } : {}),
    };
    // One retry on secondary rate-limit.
    for (let attempt = 0; attempt < 2; attempt++) {
      const resp = await this.fetchImpl(url, { method, ...init, headers });
      if (resp.status === 403 && this.isSecondaryRateLimit(resp) && attempt === 0) {
        const retry = Number(resp.headers.get("retry-after") ?? "1");
        await this.sleep(Math.max(1, retry) * 1000);
        continue;
      }
      if (!resp.ok && resp.status !== 404) {
        const text = await safeText(resp);
        throw new Error(`GitHub ${method} ${url} -> ${resp.status} ${text}`);
      }
      const remaining = Number(resp.headers.get("x-ratelimit-remaining") ?? "9999");
      const reset = Number(resp.headers.get("x-ratelimit-reset") ?? "0");
      if (remaining < 5 && reset > 0) {
        const nowSec = Math.floor(Date.now() / 1000);
        const waitMs = Math.max(0, (reset - nowSec) * 1000);
        if (waitMs > 0 && waitMs < 60_000) await this.sleep(waitMs);
      }
      const data = resp.status === 204 || resp.status === 404 ? (null as unknown as T) : ((await resp.json()) as T);
      return {
        data,
        nextCursor: parseLinkNext(resp.headers.get("link")),
        remaining,
        reset,
        headers: resp.headers,
        status: resp.status,
      };
    }
    throw new Error("GitHub: retry loop exhausted");
  }

  private isSecondaryRateLimit(resp: Response): boolean {
    const remaining = Number(resp.headers.get("x-ratelimit-remaining") ?? "9999");
    if (remaining === 0) return true;
    // Heuristic: 403 with retry-after header is a secondary rate limit.
    return resp.headers.has("retry-after");
  }
}

async function safeText(resp: Response): Promise<string> {
  try {
    return (await resp.text()).slice(0, 500);
  } catch {
    return "";
  }
}

/** Pull the `rel="next"` URL out of a GitHub Link header. */
export function parseLinkNext(link: string | null): string | null {
  if (!link) return null;
  for (const part of link.split(",")) {
    const m = /<([^>]+)>\s*;\s*rel="([^"]+)"/.exec(part.trim());
    if (m && m[2] === "next") return m[1];
  }
  return null;
}
