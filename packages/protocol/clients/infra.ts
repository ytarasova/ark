/**
 * InfraClient -- worker-registry, channel, hook, and subscription RPCs.
 *
 * These methods were added in Phase B of the conductor/server merge. They
 * expose the new JSON-RPC surface as typed helpers so callers (CLI, arkd
 * outbound client, test harnesses) never hand-roll `client.call("method", params)`.
 *
 * Subscription methods (sessionTreeStream, terminalSubscribe, logSubscribe)
 * use the `on`/`off` notification-listener infrastructure on `ArkClient`.
 * At runtime the mixin body executes with `this` pointing at `ArkClient`,
 * so `this.on` / `this.off` resolve correctly. The fields are declared with
 * `!` so TypeScript does not complain when the mixin is used standalone.
 */

import type { RpcFn } from "./rpc.js";
import type {
  WorkerRegisterParams,
  WorkerRegisterResult,
  WorkerHeartbeatParams,
  WorkerHeartbeatResult,
  WorkerDeregisterParams,
  WorkerDeregisterResult,
  WorkerListResult,
  ChannelDeliverParams,
  ChannelRelayParams,
  HookForwardParams,
  SessionStdioResult,
  SessionTranscriptResult,
  LogSubscribeResult,
  TerminalSubscribeResult,
} from "../rpc-schemas.js";

export class InfraClient {
  readonly rpc!: RpcFn;
  // Notification bus methods forwarded from `ArkClient` via `applyMixins`.
  readonly on!: (event: string, handler: (data: any) => void) => void;
  readonly off!: (event: string, handler: (data: any) => void) => void;

  constructor(rpc?: RpcFn) {
    if (rpc) this.rpc = rpc;
  }

  // ── Worker registry ─────────────────────────────────────────────────────────

  async workerRegister(params: WorkerRegisterParams): Promise<WorkerRegisterResult> {
    return this.rpc<WorkerRegisterResult>("worker/register", params as unknown as Record<string, unknown>);
  }

  async workerHeartbeat(params: WorkerHeartbeatParams): Promise<WorkerHeartbeatResult> {
    return this.rpc<WorkerHeartbeatResult>("worker/heartbeat", params as unknown as Record<string, unknown>);
  }

  async workerDeregister(params: WorkerDeregisterParams): Promise<WorkerDeregisterResult> {
    return this.rpc<WorkerDeregisterResult>("worker/deregister", params as unknown as Record<string, unknown>);
  }

  async workerList(): Promise<WorkerListResult> {
    return this.rpc<WorkerListResult>("worker/list");
  }

  // ── Channel ─────────────────────────────────────────────────────────────────

  async channelDeliver(params: ChannelDeliverParams): Promise<{ ok: true }> {
    return this.rpc<{ ok: true }>("channel/deliver", params as unknown as Record<string, unknown>);
  }

  async channelRelay(params: ChannelRelayParams): Promise<{ ok: true }> {
    return this.rpc<{ ok: true }>("channel/relay", params as unknown as Record<string, unknown>);
  }

  // ── Hook ────────────────────────────────────────────────────────────────────

  async hookForward(params: HookForwardParams): Promise<{ ok: true; guardrail?: unknown; mapped?: unknown }> {
    return this.rpc<{ ok: true; guardrail?: unknown; mapped?: unknown }>(
      "hook/forward",
      params as unknown as Record<string, unknown>,
    );
  }

  // ── Forensic reads ──────────────────────────────────────────────────────────

  async sessionStdio(sessionId: string, tail?: number): Promise<SessionStdioResult> {
    return this.rpc<SessionStdioResult>("session/stdio", { sessionId, tail });
  }

  async sessionTranscript(sessionId: string): Promise<SessionTranscriptResult> {
    return this.rpc<SessionTranscriptResult>("session/transcript", { sessionId });
  }

  // ── Subscriptions ───────────────────────────────────────────────────────────

  /**
   * Subscribe to live tree snapshots for a root session.
   *
   * Returns the initial tree and an `unsubscribe()` function. The server
   * pushes `session/tree-update` notifications whenever any descendant
   * changes. `onUpdate` is called for each update where the `sessionId`
   * matches.
   */
  async sessionTreeStream(
    sessionId: string,
    onUpdate: (root: unknown) => void,
  ): Promise<{ tree: unknown; unsubscribe: () => void }> {
    const handler = (data: { sessionId: string; root: unknown }) => {
      if (data.sessionId === sessionId) {
        onUpdate(data.root);
      }
    };
    this.on("session/tree-update", handler);
    let unsubscribed = false;
    const unsubscribe = () => {
      if (unsubscribed) return;
      unsubscribed = true;
      this.off("session/tree-update", handler);
    };
    try {
      const result = await this.rpc<{ tree: unknown }>("session/tree-stream", { sessionId });
      return { tree: result.tree, unsubscribe };
    } catch (err) {
      unsubscribe();
      throw err;
    }
  }

  /**
   * Subscribe to terminal output for a session.
   *
   * Returns a handle string and an `unsubscribe()` function. The server
   * pushes `terminal/frame` notifications (bytes as base64). `onFrame` is
   * called with a `Buffer` decoded from the base64 payload for each frame
   * whose `sessionId` matches.
   */
  async terminalSubscribe(
    sessionId: string,
    onFrame: (bytes: Buffer) => void,
  ): Promise<{ handle: string; streamHandle: string; initialBuffer: string | null; unsubscribe: () => void }> {
    const handler = (data: { sessionId: string; bytes: string }) => {
      if (data.sessionId === sessionId) {
        onFrame(Buffer.from(data.bytes, "base64"));
      }
    };
    this.on("terminal/frame", handler);
    let unsubscribed = false;
    const unsubscribe = () => {
      if (unsubscribed) return;
      unsubscribed = true;
      this.off("terminal/frame", handler);
    };
    try {
      const result = await this.rpc<TerminalSubscribeResult>("terminal/subscribe", { sessionId });
      return { ...result, unsubscribe };
    } catch (err) {
      unsubscribe();
      throw err;
    }
  }

  /**
   * Send input bytes to a terminal handle obtained from `terminalSubscribe`.
   * `bytes` is sent as a base64-encoded string over the wire.
   */
  async terminalInput(handle: string, bytes: Buffer): Promise<{ ok: true }> {
    return this.rpc<{ ok: true }>("terminal/input", { handle, bytes: bytes.toString("base64") });
  }

  /**
   * Tail a forensic log file with live push.
   *
   * Returns the current file contents as `initial` (empty string when the
   * file doesn't exist yet). New appends arrive via `log/chunk` notifications.
   * `onChunk` is called with a `Buffer` decoded from the base64 payload for
   * each chunk whose `sessionId` and `file` match.
   */
  async logSubscribe(
    sessionId: string,
    file: "stdio" | "transcript",
    onChunk: (bytes: Buffer) => void,
  ): Promise<{ initial: string; size: number; exists: boolean; unsubscribe: () => void }> {
    const handler = (data: { sessionId: string; file: string; bytes: string }) => {
      if (data.sessionId === sessionId && data.file === file) {
        onChunk(Buffer.from(data.bytes, "base64"));
      }
    };
    this.on("log/chunk", handler);
    let unsubscribed = false;
    const unsubscribe = () => {
      if (unsubscribed) return;
      unsubscribed = true;
      this.off("log/chunk", handler);
    };
    try {
      const result = await this.rpc<LogSubscribeResult>("log/subscribe", { sessionId, file });
      return { ...result, unsubscribe };
    } catch (err) {
      unsubscribe();
      throw err;
    }
  }
}
