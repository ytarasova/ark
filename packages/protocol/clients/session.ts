/**
 * SessionClient -- session lifecycle + queries + worktree RPCs.
 *
 * The "interactive" half of the session surface (messaging, gates,
 * todos, verification, spawn/fan-out/pause/resume/export/replay) lives
 * in `./session-interact.ts` to keep each mixin at <= 25 methods.
 */

import type {
  Session,
  Event,
  Message,
  SessionOpResult,
  SessionStartResult,
  SessionListParams,
  SessionListResult,
  SessionReadResult,
  SessionUpdateResult,
  SessionEventsResult,
  SessionMessagesResult,
  SessionForkResult,
  SessionCloneResult,
} from "../../types/index.js";
import type { RpcFn } from "./rpc.js";

/** Replay step returned by session/replay -- mirrors core/session/replay.ts */
export interface ReplayStep {
  index: number;
  timestamp: string;
  elapsed: string;
  type: string;
  stage: string | null;
  actor: string | null;
  summary: string;
  detail: string | null;
  data: Record<string, unknown> | null;
}

/**
 * Shape of a `SnapshotRef` as returned to RPC clients. Keeps the structural
 * contract independent of the `compute/` package so the protocol layer
 * doesn't leak compute internals.
 */
export interface SessionSnapshotRef {
  id: string;
  computeKind: string;
  sessionId: string;
  createdAt: string;
  sizeBytes: number;
  metadata: Record<string, unknown>;
}

export class SessionClient {
  // Provided by the facade (ArkClient) at runtime via `applyMixins`. When
  // a mixin is instantiated directly (optional -- the facade doesn't do
  // this), the constructor assigns it.
  readonly rpc!: RpcFn;
  constructor(rpc?: RpcFn) {
    if (rpc) this.rpc = rpc;
  }

  // ── Session Lifecycle ───────────────────────────────────────────────────────

  async sessionStart(opts: Record<string, unknown>): Promise<Session> {
    const { session } = await this.rpc<SessionStartResult>("session/start", opts);
    return session;
  }

  async sessionStop(sessionId: string): Promise<SessionOpResult> {
    return this.rpc<SessionOpResult>("session/stop", { sessionId });
  }

  async sessionAdvance(sessionId: string, force?: boolean): Promise<SessionOpResult> {
    return this.rpc<SessionOpResult>("session/advance", { sessionId, force });
  }

  async sessionComplete(sessionId: string): Promise<SessionOpResult> {
    return this.rpc<SessionOpResult>("session/complete", { sessionId });
  }

  async sessionDelete(sessionId: string): Promise<SessionOpResult> {
    return this.rpc<SessionOpResult>("session/delete", { sessionId });
  }

  async sessionUndelete(sessionId: string): Promise<SessionOpResult> {
    return this.rpc<SessionOpResult>("session/undelete", { sessionId });
  }

  async sessionFork(sessionId: string, name?: string, groupName?: string): Promise<Session> {
    const { session } = await this.rpc<SessionForkResult>("session/fork", { sessionId, name, group_name: groupName });
    return session;
  }

  async sessionClone(sessionId: string, name?: string): Promise<Session> {
    const { session } = await this.rpc<SessionCloneResult>("session/clone", { sessionId, name });
    return session;
  }

  async sessionUpdate(sessionId: string, fields: Record<string, unknown>): Promise<Session> {
    const { session } = await this.rpc<SessionUpdateResult>("session/update", { sessionId, fields });
    return session;
  }

  async sessionList(filters?: SessionListParams & Record<string, unknown>): Promise<Session[]> {
    const { sessions } = await this.rpc<SessionListResult>("session/list", filters as Record<string, unknown>);
    return sessions;
  }

  async sessionRead(sessionId: string, include?: string[]): Promise<SessionReadResult> {
    return this.rpc<SessionReadResult>("session/read", { sessionId, include });
  }

  async sessionAttachCommand(
    sessionId: string,
  ): Promise<{ command: string; displayHint: string; attachable: boolean; reason?: string }> {
    return this.rpc("session/attach-command", { sessionId });
  }

  // ── Queries ─────────────────────────────────────────────────────────────────

  async sessionEvents(sessionId: string, limit?: number): Promise<Event[]> {
    const { events } = await this.rpc<SessionEventsResult>("session/events", { sessionId, limit });
    return events;
  }

  async sessionMessages(sessionId: string, limit?: number): Promise<Message[]> {
    const { messages } = await this.rpc<SessionMessagesResult>("session/messages", { sessionId, limit });
    return messages;
  }

  // ── Worktree ────────────────────────────────────────────────────────────────

  async worktreeFinish(sessionId: string, opts?: { noMerge?: boolean }): Promise<SessionOpResult> {
    return this.rpc<SessionOpResult>("worktree/finish", { sessionId, ...opts });
  }

  async worktreeCreatePR(
    sessionId: string,
    opts?: { title?: string; body?: string; base?: string; draft?: boolean },
  ): Promise<SessionOpResult & { pr_url?: string }> {
    return this.rpc("worktree/create-pr", { sessionId, ...opts });
  }

  async worktreeDiff(
    sessionId: string,
    opts?: { base?: string },
  ): Promise<{
    ok: boolean;
    stat: string;
    diff: string;
    branch: string;
    baseBranch: string;
    filesChanged: number;
    insertions: number;
    deletions: number;
    modifiedSinceReview: string[];
    message?: string;
  }> {
    return this.rpc("worktree/diff", { sessionId, ...opts });
  }
}
