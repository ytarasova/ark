/**
 * ArkdClient -- typed HTTP wrapper for talking to an arkd instance.
 *
 * Providers use this instead of SSH / direct tmux to interact with
 * compute targets.
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
} from "../common/types.js";
import { ArkdClientError } from "../common/errors.js";
import { fetchWithRetry } from "./retry.js";
import { webSocketToAsyncIterable } from "./ws-iterator.js";

export class ArkdClient {
  private token: string | null;
  private requestTimeoutMs: number;

  constructor(
    private baseUrl: string,
    opts?: { token?: string; requestTimeoutMs?: number },
  ) {
    if (this.baseUrl.endsWith("/")) {
      this.baseUrl = this.baseUrl.slice(0, -1);
    }
    this.token = opts?.token ?? process.env.ARK_ARKD_TOKEN ?? null;
    this.requestTimeoutMs = opts?.requestTimeoutMs ?? 30_000;
  }

  // -- File operations ---------------------------------------------------------

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

  // -- Process running ---------------------------------------------------------

  async run(req: ExecReq): Promise<ExecRes> {
    const serverTimeout = typeof req.timeout === "number" ? req.timeout : 30_000;
    const effectiveTimeout = Math.max(this.requestTimeoutMs, serverTimeout + 30_000);
    return this.post("/exec", req, { timeoutMs: effectiveTimeout });
  }

  // -- Generic process supervisor ----------------------------------------------

  async spawnProcess(req: ProcessSpawnReq): Promise<ProcessSpawnRes> {
    return this.post("/process/spawn", req);
  }

  async killProcess(req: ProcessKillReq): Promise<ProcessKillRes> {
    return this.post("/process/kill", req);
  }

  async statusProcess(req: ProcessStatusReq): Promise<ProcessStatusRes> {
    return this.post("/process/status", req);
  }

  // -- Agent lifecycle (LEGACY tmux wrappers) ----------------------------------

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

  // -- Generic channel pub/sub -------------------------------------------------

  async publishToChannel(channel: string, envelope: Record<string, unknown>): Promise<ChannelPublishRes> {
    return this.post(`/channel/${encodeURIComponent(channel)}/publish`, { envelope });
  }

  subscribeToChannel<E extends Record<string, unknown> = Record<string, unknown>>(
    channel: string,
    opts?: { signal?: AbortSignal },
  ): Promise<AsyncIterable<E>> {
    const wsBase = this.baseUrl.replace(/^http(s?):\/\//, "ws$1://");
    const url = `${wsBase}/ws/channel/${encodeURIComponent(channel)}`;
    const protocols = this.token ? [`Bearer.${this.token}`] : undefined;
    const ws = new WebSocket(url, protocols);
    return webSocketToAsyncIterable<E>(ws, channel, opts?.signal);
  }

  // -- Terminal attach (live) --------------------------------------------------

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
   * `Response` so callers can pipe the body directly. The connect timeout
   * caps headers; once headers arrive the body stream lives independently.
   */
  async attachStream(streamHandle: string): Promise<Response> {
    const ac = new AbortController();
    const t = setTimeout(
      () => ac.abort(new Error(`arkd attachStream: timeout after ${this.requestTimeoutMs}ms`)),
      this.requestTimeoutMs,
    );
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

  // -- System ------------------------------------------------------------------

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

  // -- Channel relay -----------------------------------------------------------

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

  // -- Internal ----------------------------------------------------------------

  private authHeaders(): Record<string, string> {
    if (this.token) return { Authorization: `Bearer ${this.token}` };
    return {};
  }

  private async post<Req, Res>(path: string, body: Req, opts?: { timeoutMs?: number }): Promise<Res> {
    const timeoutMs = opts?.timeoutMs ?? this.requestTimeoutMs;
    const resp = await fetchWithRetry(
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
    const resp = await fetchWithRetry(
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
