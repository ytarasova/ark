/**
 * Bitbucket Cloud REST v2 HTTP client.
 *
 * Auth: Basic (username + app password) OR Bearer (OAuth 2). Bitbucket does
 * not support PATs the way GitHub does; app passwords go through Basic.
 *
 * Pagination: BB uses a cursor-style `{ values, next, page, pagelen }`
 * envelope. The `next` field is a full URL (or absent) -- identical
 * semantics to GitHub's Link header but shaped differently.
 *
 * Rate limit: BB Cloud returns 429 with Retry-After on saturation; no
 * primary-limit remaining header. We retry once.
 */

import type { TicketCredentials } from "../../types.js";

export interface BitbucketClientOptions {
  credentials: TicketCredentials;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export interface BitbucketResponse<T> {
  data: T;
  nextCursor: string | null;
  headers: Headers;
  status: number;
}

export interface BitbucketPage<T> {
  values: T[];
  next?: string;
  page?: number;
  pagelen?: number;
  size?: number;
}

const DEFAULT_BASE = "https://api.bitbucket.org/2.0";

export class BitbucketClient {
  private readonly baseUrl: string;
  private readonly authHeader: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(opts: BitbucketClientOptions) {
    this.baseUrl = (opts.credentials.baseUrl ?? DEFAULT_BASE).replace(/\/+$/, "");
    this.authHeader = resolveAuth(opts.credentials);
    this.fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async get<T>(pathOrUrl: string): Promise<BitbucketResponse<T>> {
    return this.request<T>("GET", pathOrUrl);
  }

  async post<T>(pathOrUrl: string, body: unknown): Promise<BitbucketResponse<T>> {
    return this.request<T>("POST", pathOrUrl, body);
  }

  async put<T>(pathOrUrl: string, body: unknown): Promise<BitbucketResponse<T>> {
    return this.request<T>("PUT", pathOrUrl, body);
  }

  async delete<T>(pathOrUrl: string): Promise<BitbucketResponse<T>> {
    return this.request<T>("DELETE", pathOrUrl);
  }

  /** Paginate by following `next` URLs. */
  async paginate<T>(path: string): Promise<T[]> {
    const out: T[] = [];
    let url: string | null = path;
    while (url) {
      const res = await this.get<BitbucketPage<T>>(url);
      if (Array.isArray(res.data?.values)) out.push(...res.data.values);
      url = res.data?.next ?? null;
    }
    return out;
  }

  private async request<T>(method: string, pathOrUrl: string, body?: unknown): Promise<BitbucketResponse<T>> {
    const url = pathOrUrl.startsWith("http") ? pathOrUrl : `${this.baseUrl}${pathOrUrl}`;
    const headers: Record<string, string> = {
      accept: "application/json",
      authorization: this.authHeader,
    };
    if (body !== undefined) headers["content-type"] = "application/json";

    for (let attempt = 0; attempt < 2; attempt++) {
      const resp = await this.fetchImpl(url, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      if (resp.status === 429 && attempt === 0) {
        const retry = Number(resp.headers.get("retry-after") ?? "1");
        await this.sleep(Math.max(1, retry) * 1000);
        continue;
      }
      if (!resp.ok && resp.status !== 404) {
        const text = (await resp.text()).slice(0, 500);
        throw new Error(`Bitbucket ${method} ${url} -> ${resp.status} ${text}`);
      }
      const data = resp.status === 204 || resp.status === 404 ? (null as unknown as T) : ((await resp.json()) as T);
      const nextCursor =
        typeof (data as BitbucketPage<unknown> | null)?.next === "string"
          ? ((data as BitbucketPage<unknown>).next as string)
          : null;
      return { data, nextCursor, headers: resp.headers, status: resp.status };
    }
    throw new Error("Bitbucket: retry loop exhausted");
  }
}

function resolveAuth(c: TicketCredentials): string {
  if (c.bearer) return `Bearer ${c.bearer}`;
  if (c.username && c.password) {
    const raw = `${c.username}:${c.password}`;
    const b64 = typeof Buffer !== "undefined" ? Buffer.from(raw).toString("base64") : btoa(raw);
    return `Basic ${b64}`;
  }
  if (c.token) return `Bearer ${c.token}`;
  throw new Error("BitbucketClient: credentials must provide bearer, or username+password, or token");
}
