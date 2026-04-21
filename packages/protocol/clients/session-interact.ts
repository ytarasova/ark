/**
 * SessionInteractClient -- the "user interaction" half of the session
 * surface: messaging, gates, inputs, todos, verification, and the
 * extended session operations (spawn, fan-out, pause/resume, archive,
 * export, replay).
 *
 * Split out of the original monolithic SessionClient to keep each mixin
 * under 25 methods. Lifecycle / queries / worktree stay in
 * `./session.ts`.
 */

import type { SessionOpResult, SessionOutputResult } from "../../types/index.js";
import type { RpcFn } from "./rpc.js";
import type { ReplayStep, SessionSnapshotRef } from "./session.js";

export class SessionInteractClient {
  readonly rpc!: RpcFn;
  constructor(rpc?: RpcFn) {
    if (rpc) this.rpc = rpc;
  }

  // ── Messaging + gates ───────────────────────────────────────────────────────

  async messageSend(sessionId: string, content: string): Promise<void> {
    await this.rpc("message/send", { sessionId, content });
  }

  async messageMarkRead(sessionId: string): Promise<void> {
    await this.rpc("message/markRead", { sessionId });
  }

  async gateApprove(sessionId: string): Promise<SessionOpResult> {
    return this.rpc<SessionOpResult>("gate/approve", { sessionId });
  }

  /** Reject a review gate with a reason; triggers a rework cycle. */
  async gateReject(sessionId: string, reason: string): Promise<SessionOpResult> {
    return this.rpc<SessionOpResult>("gate/reject", { sessionId, reason });
  }

  /** Alias used by CLI + web UI -- matches the `sessionReject` naming scheme. */
  async sessionReject(sessionId: string, reason: string): Promise<SessionOpResult> {
    return this.gateReject(sessionId, reason);
  }

  // ── Input blobs ─────────────────────────────────────────────────────────────

  /**
   * Upload a session input file. Server persists through the configured
   * BlobStore (local disk or S3) and returns an opaque locator.
   */
  async inputUpload(opts: {
    name: string;
    role: string;
    content: string;
    contentEncoding?: "base64" | "utf-8";
  }): Promise<{ locator: string }> {
    return this.rpc<{ locator: string }>("input/upload", opts as unknown as Record<string, unknown>);
  }

  /** Read back a previously-uploaded input by locator. Tenant-enforced. */
  async inputRead(locator: string): Promise<{
    filename: string;
    contentType: string;
    content: string;
    contentEncoding: "base64";
    size: number;
  }> {
    return this.rpc("input/read", { locator });
  }

  // ── Session extended ────────────────────────────────────────────────────────

  async sessionOutput(sessionId: string, lines?: number): Promise<string> {
    const { output } = await this.rpc<SessionOutputResult>("session/output", { sessionId, lines });
    return output;
  }

  async sessionHandoff(sessionId: string, agent: string, instructions?: string): Promise<SessionOpResult> {
    return this.rpc<SessionOpResult>("session/handoff", { sessionId, agent, instructions });
  }

  async sessionJoin(sessionId: string, force?: boolean): Promise<SessionOpResult> {
    return this.rpc<SessionOpResult>("session/join", { sessionId, force });
  }

  async sessionSpawn(
    sessionId: string,
    opts: { task: string; agent?: string; model?: string; group_name?: string },
  ): Promise<SessionOpResult & { sessionId?: string }> {
    return this.rpc<SessionOpResult & { sessionId?: string }>("session/spawn", { sessionId, ...opts });
  }

  async sessionFanOut(
    sessionId: string,
    tasks: Array<{ summary: string; agent?: string; flow?: string }>,
  ): Promise<{ ok: boolean; childIds?: string[]; message?: string }> {
    return this.rpc<{ ok: boolean; childIds?: string[]; message?: string }>("session/fan-out", { sessionId, tasks });
  }

  async sessionResume(sessionId: string, snapshotId?: string): Promise<SessionOpResult & { snapshotId?: string }> {
    return this.rpc<SessionOpResult & { snapshotId?: string }>("session/resume", { sessionId, snapshotId });
  }

  async sessionPause(
    sessionId: string,
    reason?: string,
  ): Promise<SessionOpResult & { snapshot?: SessionSnapshotRef | null; notSupported?: boolean }> {
    return this.rpc<SessionOpResult & { snapshot?: SessionSnapshotRef | null; notSupported?: boolean }>(
      "session/pause",
      { sessionId, reason },
    );
  }

  async sessionInterrupt(sessionId: string): Promise<SessionOpResult> {
    return this.rpc<SessionOpResult>("session/interrupt", { sessionId });
  }

  async sessionArchive(sessionId: string): Promise<SessionOpResult> {
    return this.rpc<SessionOpResult>("session/archive", { sessionId });
  }

  async sessionRestore(sessionId: string): Promise<SessionOpResult> {
    return this.rpc<SessionOpResult>("session/restore", { sessionId });
  }

  async sessionExport(sessionId: string, filePath?: string): Promise<{ ok: boolean; filePath?: string; data?: any }> {
    return this.rpc<{ ok: boolean; filePath?: string; data?: any }>("session/export", { sessionId, filePath });
  }

  async sessionReplay(sessionId: string): Promise<ReplayStep[]> {
    const { steps } = await this.rpc<{ steps: ReplayStep[] }>("session/replay", { sessionId });
    return steps;
  }

  // ── Todos & Verification ────────────────────────────────────────────────────

  async todoList(sessionId: string): Promise<{ todos: any[] }> {
    return this.rpc("todo/list", { sessionId });
  }

  async todoAdd(sessionId: string, content: string): Promise<{ todo: any }> {
    return this.rpc("todo/add", { sessionId, content });
  }

  async todoToggle(id: number): Promise<{ todo: any }> {
    return this.rpc("todo/toggle", { id });
  }

  async todoDelete(id: number): Promise<{ ok: boolean }> {
    return this.rpc("todo/delete", { id });
  }

  async verifyRun(sessionId: string): Promise<any> {
    return this.rpc("verify/run", { sessionId });
  }
}
