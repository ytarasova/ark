/**
 * Minimal Jira REST HTTP client.
 *
 * Responsibilities:
 *   - Build the auth header from `TicketCredentials` (basic for API token,
 *     bearer for OAuth / Connect-issued tokens).
 *   - Compose the base URL from `credentials.baseUrl` (or the Atlassian cloud
 *     default `https://<tenant>.atlassian.net`, which callers must supply).
 *   - JSON body serialization + JSON response parsing.
 *   - 429 backoff with `Retry-After` and exponential fallback when the header
 *     is missing, capped at `MAX_RETRIES`.
 *   - A tiny in-process, per-tenant rate limiter (token bucket style, scoped
 *     by base URL) so a single tenant cannot burst the cloud API. Distributed
 *     throttling belongs in Redis / control-plane; this module is intentionally
 *     best-effort.
 *
 * We inject `fetchImpl` so tests can swap `fetch`. In production callers pass
 * `globalThis.fetch` (Bun provides it natively).
 */

import type { TicketCredentials } from "../../types.js";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface JiraClientOptions {
  credentials: TicketCredentials;
  /** Injected fetch -- defaults to `globalThis.fetch`. */
  fetchImpl?: FetchLike;
  /** Override retry budget. Default 4. */
  maxRetries?: number;
  /** Override base backoff (ms). Default 500. */
  backoffBaseMs?: number;
  /** Clock for backoff sleeps. Test helper. */
  sleep?: (ms: number) => Promise<void>;
}

export interface JiraRequest {
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
}

export class JiraApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly statusText: string,
    public readonly body: string,
    public readonly url: string,
  ) {
    super(`Jira API ${status} ${statusText} at ${url}: ${body.slice(0, 200)}`);
    this.name = "JiraApiError";
  }
}

const DEFAULT_MAX_RETRIES = 4;
const DEFAULT_BACKOFF_MS = 500;

/** Per-tenant (keyed by base URL) rate limiter. In-memory only. */
const PER_TENANT_BUCKETS = new Map<string, { tokens: number; updatedAt: number }>();
const BUCKET_CAPACITY = 30;
const BUCKET_REFILL_PER_SEC = 10;

function takeToken(baseUrl: string, now: number): number {
  const bucket = PER_TENANT_BUCKETS.get(baseUrl) ?? { tokens: BUCKET_CAPACITY, updatedAt: now };
  const elapsedSec = Math.max(0, (now - bucket.updatedAt) / 1000);
  bucket.tokens = Math.min(BUCKET_CAPACITY, bucket.tokens + elapsedSec * BUCKET_REFILL_PER_SEC);
  bucket.updatedAt = now;
  if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    PER_TENANT_BUCKETS.set(baseUrl, bucket);
    return 0;
  }
  const deficit = 1 - bucket.tokens;
  const waitMs = Math.ceil((deficit / BUCKET_REFILL_PER_SEC) * 1000);
  PER_TENANT_BUCKETS.set(baseUrl, bucket);
  return waitMs;
}

/** Reset the in-memory rate-limit buckets. Test-only. */
export function resetJiraRateLimiter(): void {
  PER_TENANT_BUCKETS.clear();
}

export class JiraClient {
  private readonly credentials: TicketCredentials;
  private readonly fetchImpl: FetchLike;
  private readonly maxRetries: number;
  private readonly backoffBaseMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(opts: JiraClientOptions) {
    this.credentials = opts.credentials;
    this.fetchImpl = opts.fetchImpl ?? ((globalThis as { fetch?: FetchLike }).fetch as FetchLike);
    this.maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.backoffBaseMs = opts.backoffBaseMs ?? DEFAULT_BACKOFF_MS;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** Build the `Authorization` header value. Exposed for tests. */
  authHeader(): string {
    const { token, bearer, username, password } = this.credentials;
    if (bearer) return `Bearer ${bearer}`;
    if (username && (password || token)) {
      const secret = password ?? token ?? "";
      const encoded = Buffer.from(`${username}:${secret}`).toString("base64");
      return `Basic ${encoded}`;
    }
    if (token) return `Bearer ${token}`;
    throw new Error("JiraClient: no credentials (need token, bearer, or username+password/token)");
  }

  baseUrl(): string {
    const url = this.credentials.baseUrl;
    if (!url) throw new Error("JiraClient: credentials.baseUrl is required");
    return url.replace(/\/$/, "");
  }

  buildUrl(path: string, query?: Record<string, string | number | boolean | undefined>): string {
    const base = this.baseUrl();
    const suffix = path.startsWith("/") ? path : `/${path}`;
    if (!query) return `${base}${suffix}`;
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined) continue;
      params.append(k, String(v));
    }
    const qs = params.toString();
    return qs ? `${base}${suffix}?${qs}` : `${base}${suffix}`;
  }

  async request<T = unknown>(req: JiraRequest): Promise<T> {
    const url = this.buildUrl(req.path, req.query);
    const headers: Record<string, string> = {
      Authorization: this.authHeader(),
      Accept: "application/json",
    };
    if (req.body !== undefined) headers["Content-Type"] = "application/json";

    let attempt = 0;
    // Token-bucket wait before each attempt (including retries).
    while (true) {
      const waitMs = takeToken(this.baseUrl(), Date.now());
      if (waitMs > 0) await this.sleep(waitMs);

      const response = await this.fetchImpl(url, {
        method: req.method,
        headers,
        body: req.body !== undefined ? JSON.stringify(req.body) : undefined,
      });

      if (response.status === 429 && attempt < this.maxRetries) {
        const retryAfter = Number(response.headers.get("retry-after") ?? 0);
        const waitMs = retryAfter > 0 ? retryAfter * 1000 : this.backoffBaseMs * Math.pow(2, attempt);
        await this.sleep(waitMs);
        attempt += 1;
        continue;
      }

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new JiraApiError(response.status, response.statusText, text, url);
      }

      if (response.status === 204) return undefined as unknown as T;
      const ct = response.headers.get("content-type") ?? "";
      if (!ct.includes("application/json")) {
        // Fall back to text -> JSON so tests with mock Response work either way.
        const text = await response.text();
        if (!text) return undefined as unknown as T;
        try {
          return JSON.parse(text) as T;
        } catch {
          return text as unknown as T;
        }
      }
      return (await response.json()) as T;
    }
  }
}
