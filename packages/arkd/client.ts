/**
 * ArkdClient - typed HTTP wrapper for talking to an arkd instance.
 *
 * Providers use this instead of SSH / direct tmux to interact with compute targets.
 */

import type {
  ReadFileRes,
  WriteFileReq,
  WriteFileRes,
  ListDirReq,
  ListDirRes,
  StatRes,
  MkdirReq,
  MkdirRes,
  ExecReq,
  ExecRes,
  ProcessSpawnReq,
  ProcessSpawnRes,
  ProcessKillReq,
  ProcessKillRes,
  ProcessStatusReq,
  ProcessStatusRes,
  AgentLaunchReq,
  AgentLaunchRes,
  AgentKillReq,
  AgentKillRes,
  AgentStatusReq,
  AgentStatusRes,
  AgentCaptureReq,
  AgentCaptureRes,
  AgentAttachOpenReq,
  AgentAttachOpenRes,
  AgentAttachInputReq,
  AgentAttachInputRes,
  AgentAttachResizeReq,
  AgentAttachResizeRes,
  AgentAttachCloseReq,
  AgentAttachCloseRes,
  ChannelPublishRes,
  MetricsRes,
  ProbePortsRes,
  HealthRes,
  SnapshotRes,
  ChannelReportRes,
  ChannelRelayReq,
  ChannelRelayRes,
  ChannelDeliverReq,
  ChannelDeliverRes,
  ConfigRes,
  ArkdError,
} from "./types.js";

export class ArkdClient {
  private token: string | null;
  private requestTimeoutMs: number;

  constructor(
    private baseUrl: string,
    opts?: { token?: string; requestTimeoutMs?: number },
  ) {
    // Strip trailing slash
    if (this.baseUrl.endsWith("/")) {
      this.baseUrl = this.baseUrl.slice(0, -1);
    }
    this.token = opts?.token ?? process.env.ARK_ARKD_TOKEN ?? null;
    // 30s covers `/snapshot` on a loaded macOS host (top + vm_stat + tmux +
    // docker stats in parallel) without masking a genuinely gone daemon.
    // Callers hitting `/health` or `/exec` normally return in <1s so the
    // extra headroom costs nothing on the happy path.
    //
    // EVERY fetch call in this client MUST honor this timeout. The Pass-5
    // remediation traced a 7+ minute hang to a fetch against an unreachable
    // arkd URL: an `AbortSignal.timeout` on every single fetch is the only
    // belt-side guarantee that a dispatch eventually surfaces failure rather
    // than sitting at status=ready forever.
    this.requestTimeoutMs = opts?.requestTimeoutMs ?? 30_000;
  }

  // ── File operations ───────────────────────────────────────────────────────

  async readFile(path: string): Promise<ReadFileRes> {
    return this.post("/file/read", { path });
  }

  async writeFile(req: WriteFileReq): Promise<WriteFileRes> {
    return this.post("/file/write", req);
  }

  async stat(path: string): Promise<StatRes> {
    return this.post("/file/stat", { path });
  }

  async mkdir(req: MkdirReq): Promise<MkdirRes> {
    return this.post("/file/mkdir", req);
  }

  async listDir(req: ListDirReq): Promise<ListDirRes> {
    return this.post("/file/list", req);
  }

  // ── Process running ───────────────────────────────────────────────────────

  /**
   * Run a command on arkd. The fetch timeout is derived from the server-side
   * `req.timeout` (default 30_000ms) so we don't abort the HTTP request
   * before arkd can finish executing. We add a 30s buffer to cover the time
   * it takes arkd to package up the response after the child exits.
   *
   * Without this, callers who set `timeout: 300_000` (e.g. `docker pull`) hit
   * the default 30s `requestTimeoutMs` ceiling on the client side and saw
   * fetch aborts mid-exec with no useful error.
   */
  async run(req: ExecReq): Promise<ExecRes> {
    const serverTimeout = typeof req.timeout === "number" ? req.timeout : 30_000;
    const effectiveTimeout = Math.max(this.requestTimeoutMs, serverTimeout + 30_000);
    return this.post("/exec", req, { timeoutMs: effectiveTimeout });
  }

  // ── Generic process supervisor ───────────────────────────────────────────
  //
  // Generic spawn/kill/status keyed by a caller-supplied handle. The agent
  // runtime decides what command to spawn (tmux for claude-code, plain bash
  // for claude-agent, etc.); arkd just tracks pids. No "agent" semantics.

  async spawnProcess(req: ProcessSpawnReq): Promise<ProcessSpawnRes> {
    return this.post("/process/spawn", req);
  }

  async killProcess(req: ProcessKillReq): Promise<ProcessKillRes> {
    return this.post("/process/kill", req);
  }

  async statusProcess(req: ProcessStatusReq): Promise<ProcessStatusRes> {
    return this.post("/process/status", req);
  }

  // ── Agent lifecycle (LEGACY tmux wrappers) ───────────────────────────────
  //
  // Used by the claude-code runtime which still drives tmux directly. The
  // claude-agent runtime moved to /process/spawn (generic). Phase C will
  // retire these.

  async launchAgent(req: AgentLaunchReq): Promise<AgentLaunchRes> {
    return this.post("/agent/launch", req);
  }

  async killAgent(req: AgentKillReq): Promise<AgentKillRes> {
    return this.post("/agent/kill", req);
  }

  async agentStatus(req: AgentStatusReq): Promise<AgentStatusRes> {
    return this.post("/agent/status", req);
  }

  async captureOutput(req: AgentCaptureReq): Promise<AgentCaptureRes> {
    return this.post("/agent/capture", req);
  }

  // ── Generic channel pub/sub ──────────────────────────────────────────────

  /**
   * Publish an opaque envelope to a named channel. arkd treats the envelope
   * as opaque JSON -- subscribers see whatever fields the publisher set.
   * `delivered` reports whether arkd handed the envelope directly to a
   * parked subscriber (true) or buffered it on the channel ring for the
   * next subscribe call (false). Buffered envelopes are still durable: the
   * next subscriber drains them in FIFO order on connect.
   */
  async publishToChannel(channel: string, envelope: Record<string, unknown>): Promise<ChannelPublishRes> {
    return this.post(`/channel/${encodeURIComponent(channel)}/publish`, { envelope });
  }

  /**
   * Subscribe to a named channel. Returns an async iterable of envelopes;
   * the underlying fetch stays open as long as the consumer is iterating.
   * Cancel by breaking out of the for-await loop or aborting the
   * AbortSignal. Each envelope is whatever the publisher passed to
   * `publishToChannel` -- the typed shape is up to the publisher/consumer
   * pair to agree on.
   */
  async *subscribeToChannel<E extends Record<string, unknown> = Record<string, unknown>>(
    channel: string,
    opts?: { signal?: AbortSignal },
  ): AsyncIterable<E> {
    const url = `${this.baseUrl}/channel/${encodeURIComponent(channel)}/subscribe`;
    const headers: Record<string, string> = {};
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    const res = await fetch(url, { headers, signal: opts?.signal });
    if (!res.ok || !res.body) {
      throw new ArkdClientError(`channel subscribe failed: ${res.status}`, undefined, res.status);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) return;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        try {
          yield JSON.parse(line) as E;
        } catch {
          // Skip malformed lines; arkd never emits them, but a future
          // protocol drop should not crash the SDK loop.
        }
      }
    }
  }

  // ── Terminal attach (live) ───────────────────────────────────────────────

  async attachOpen(req: AgentAttachOpenReq): Promise<AgentAttachOpenRes> {
    return this.post("/agent/attach/open", req);
  }

  async attachInput(req: AgentAttachInputReq): Promise<AgentAttachInputRes> {
    return this.post("/agent/attach/input", req);
  }

  async attachResize(req: AgentAttachResizeReq): Promise<AgentAttachResizeRes> {
    return this.post("/agent/attach/resize", req);
  }

  async attachClose(req: AgentAttachCloseReq): Promise<AgentAttachCloseRes> {
    return this.post("/agent/attach/close", req);
  }

  /**
   * Open the chunked byte stream for an attach handle. Returns the raw
   * `Response` so callers can pipe the body directly. The response stays
   * open until the handle is closed or the server tears it down.
   *
   * Connect timeout: we still cap the time spent waiting for response
   * headers via `AbortSignal.timeout(requestTimeoutMs)`. Once `fetch()`
   * resolves the headers are in and the body stream lives independently
   * (the AbortSignal does NOT abort the in-flight body once headers
   * arrive). Without this, an unreachable arkd would leave the fetch
   * pending indefinitely -- the same hang shape the Pass-5 remediation
   * is fixing on the JSON paths.
   *
   * Throws if the server returns a non-2xx.
   */
  async attachStream(streamHandle: string): Promise<Response> {
    const ac = new AbortController();
    const t = setTimeout(
      () => ac.abort(new Error(`arkd attachStream: timeout after ${this.requestTimeoutMs}ms`)),
      this.requestTimeoutMs,
    );
    // Don't clear `t` in a finally -- once headers arrive and we return the
    // Response, the body stream lives on independently. Caller is expected
    // to consume the stream promptly. Worst case we leak a no-op timer.
    void t;
    const resp = await fetch(`${this.baseUrl}/agent/attach/stream?handle=${encodeURIComponent(streamHandle)}`, {
      headers: this.authHeaders(),
      signal: ac.signal,
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw new ArkdClientError(`arkd /agent/attach/stream: ${body || resp.statusText}`, undefined, resp.status);
    }
    return resp;
  }

  // ── System ────────────────────────────────────────────────────────────────

  async health(): Promise<HealthRes> {
    return this.get("/health");
  }

  async metrics(): Promise<MetricsRes> {
    return this.get("/metrics");
  }

  async snapshot(): Promise<SnapshotRes> {
    return this.get("/snapshot");
  }

  async probePorts(ports: number[]): Promise<ProbePortsRes> {
    return this.post("/ports/probe", { ports });
  }

  // ── Channel relay ────────────────────────────────────────────────────────

  async channelReport(sessionId: string, report: Record<string, unknown>): Promise<ChannelReportRes> {
    return this.post(`/channel/${sessionId}`, report);
  }

  async channelRelay(req: ChannelRelayReq): Promise<ChannelRelayRes> {
    return this.post("/channel/relay", req);
  }

  async channelDeliver(req: ChannelDeliverReq): Promise<ChannelDeliverRes> {
    return this.post("/channel/deliver", req);
  }

  async setConfig(config: { conductorUrl?: string }): Promise<ConfigRes> {
    return this.post("/config", config);
  }

  async getConfig(): Promise<ConfigRes> {
    return this.get("/config");
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  private authHeaders(): Record<string, string> {
    if (this.token) return { Authorization: `Bearer ${this.token}` };
    return {};
  }

  /**
   * Recognize transient transport-level fetch failures: a stale pooled
   * keep-alive socket closed by the peer (or the SSM port-forward that
   * carries it) surfaces as `TypeError: The socket connection was closed
   * unexpectedly`. Bun's connection pool can hand out a socket that the
   * underlying tunnel has already torn down without the runtime noticing --
   * the next fetch issues an HTTP request, the kernel returns RST, and we
   * get this error. Retrying immediately opens a fresh socket and almost
   * always succeeds.
   *
   * We intentionally do NOT retry timeouts (those are caller-shaped) or
   * ArkdClientError (those are real arkd-side rejects with codes).
   */
  private isTransientTransportError(e: unknown): boolean {
    if (e instanceof ArkdClientError) return false;
    const msg = (e as { message?: string })?.message ?? String(e);
    return (
      msg.includes("socket connection was closed") ||
      msg.includes("ECONNRESET") ||
      msg.includes("ECONNREFUSED") ||
      msg.includes("EPIPE") ||
      msg.includes("fetch failed")
    );
  }

  private async fetchWithRetry(
    url: string,
    init: RequestInit,
    timeoutMs: number,
    path: string,
    method: "GET" | "POST",
  ): Promise<Response> {
    // Two retries on transient transport errors. Backoff: 250ms, 1s.
    // Each attempt gets the full timeout budget -- we don't shorten it,
    // because the original request might have been partway through a long
    // arkd-side exec; we'd rather wait the timeout than fail-fast on the
    // first transient close.
    const delays = [250, 1000];
    let lastErr: unknown = null;
    for (let attempt = 0; ; attempt++) {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(new Error(`arkd ${path}: timeout after ${timeoutMs}ms`)), timeoutMs);
      try {
        return await fetch(url, { ...init, signal: ac.signal });
      } catch (e) {
        lastErr = e;
        if (attempt < delays.length && this.isTransientTransportError(e)) {
          await new Promise((r) => setTimeout(r, delays[attempt]));
          continue;
        }
        // Wrap with full request context so callers (and the operator
        // staring at the failure in the UI) can tell *which* request
        // failed without spelunking through stack frames. Original
        // error is preserved as `cause`.
        throw new ArkdClientTransportError(
          `arkd ${method} ${url} failed after ${attempt + 1} attempt(s): ` +
            `${(e as { message?: string })?.message ?? String(e)}`,
          { url, method, path, attempts: attempt + 1, cause: e },
        );
      } finally {
        clearTimeout(t);
      }
    }
    // Unreachable but TypeScript wants it.
    throw lastErr;
  }

  private async post<Req, Res>(path: string, body: Req, opts?: { timeoutMs?: number }): Promise<Res> {
    const timeoutMs = opts?.timeoutMs ?? this.requestTimeoutMs;
    const resp = await this.fetchWithRetry(
      `${this.baseUrl}${path}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", ...this.authHeaders() },
        body: JSON.stringify(body),
      },
      timeoutMs,
      path,
      "POST",
    );
    const data = await resp.json();
    if (!resp.ok) {
      const err = data as ArkdError;
      throw new ArkdClientError(`arkd ${path}: ${err.error}`, err.code, resp.status);
    }
    return data as Res;
  }

  private async get<Res>(path: string, opts?: { timeoutMs?: number }): Promise<Res> {
    const timeoutMs = opts?.timeoutMs ?? this.requestTimeoutMs;
    const resp = await this.fetchWithRetry(
      `${this.baseUrl}${path}`,
      { headers: this.authHeaders() },
      timeoutMs,
      path,
      "GET",
    );
    const data = await resp.json();
    if (!resp.ok) {
      const err = data as ArkdError;
      throw new ArkdClientError(`arkd ${path}: ${err.error}`, err.code, resp.status);
    }
    return data as Res;
  }
}

/**
 * Error thrown when fetch() itself fails (DNS / connect / socket-close /
 * timeout) -- distinct from `ArkdClientError`, which is a clean non-2xx
 * arkd-side reject. Carries the request URL + method + attempt count so
 * a session that fails dispatch surfaces an actionable message in the
 * UI instead of a bare `TypeError: socket closed`. The original error
 * is preserved on `.cause` for stack-trace reconstruction.
 */
export class ArkdClientTransportError extends Error {
  readonly url: string;
  readonly method: string;
  readonly path: string;
  readonly attempts: number;
  constructor(message: string, opts: { url: string; method: string; path: string; attempts: number; cause?: unknown }) {
    super(message, { cause: opts.cause });
    this.name = "ArkdClientTransportError";
    this.url = opts.url;
    this.method = opts.method;
    this.path = opts.path;
    this.attempts = opts.attempts;
  }
}

/** Error thrown by ArkdClient when the server returns a non-2xx response. */
export class ArkdClientError extends Error {
  constructor(
    message: string,
    public readonly code?: string,
    public readonly httpStatus?: number,
  ) {
    super(message);
    this.name = "ArkdClientError";
  }
}
