/**
 * ArkdClient — typed HTTP wrapper for talking to an arkd instance.
 *
 * Providers use this instead of SSH / direct tmux to interact with compute targets.
 */

import type {
  ReadFileRes,
  WriteFileReq, WriteFileRes,
  ListDirReq, ListDirRes,
  StatRes,
  MkdirReq, MkdirRes,
  ExecReq, ExecRes,
  AgentLaunchReq, AgentLaunchRes,
  AgentKillReq, AgentKillRes,
  AgentStatusReq, AgentStatusRes,
  AgentCaptureReq, AgentCaptureRes,
  MetricsRes,
  ProbePortsRes,
  HealthRes,
  ArkdError,
} from "./types.js";

export class ArkdClient {
  constructor(private baseUrl: string) {
    // Strip trailing slash
    if (this.baseUrl.endsWith("/")) {
      this.baseUrl = this.baseUrl.slice(0, -1);
    }
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

  async run(req: ExecReq): Promise<ExecRes> {
    return this.post("/exec", req);
  }

  // ── Agent lifecycle ───────────────────────────────────────────────────────

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

  // ── System ────────────────────────────────────────────────────────────────

  async health(): Promise<HealthRes> {
    return this.get("/health");
  }

  async metrics(): Promise<MetricsRes> {
    return this.get("/metrics");
  }

  async probePorts(ports: number[]): Promise<ProbePortsRes> {
    return this.post("/ports/probe", { ports });
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  private async post<Req, Res>(path: string, body: Req): Promise<Res> {
    const resp = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await resp.json();
    if (!resp.ok) {
      const err = data as ArkdError;
      throw new ArkdClientError(`arkd ${path}: ${err.error}`, err.code, resp.status);
    }
    return data as Res;
  }

  private async get<Res>(path: string): Promise<Res> {
    const resp = await fetch(`${this.baseUrl}${path}`);
    const data = await resp.json();
    if (!resp.ok) {
      const err = data as ArkdError;
      throw new ArkdClientError(`arkd ${path}: ${err.error}`, err.code, resp.status);
    }
    return data as Res;
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
