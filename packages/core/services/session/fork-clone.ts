/**
 * SessionForker -- fork + clone.
 * Extracted from the old session-lifecycle.ts.
 */

import type { LifecycleHooks, SessionLifecycleDeps, SessionOpResult } from "./types.js";

export class SessionForker {
  constructor(private readonly deps: SessionLifecycleDeps) {}

  /**
   * Fork: shallow copy -- same compute, repo, flow, group. Fresh session, no resume.
   */
  async fork(sessionId: string, newName?: string, hooks?: LifecycleHooks): Promise<SessionOpResult> {
    const d = this.deps;
    const original = await d.sessions.get(sessionId);
    if (!original) return { ok: false, message: `Session ${sessionId} not found` };

    const baseName = original.summary || sessionId;
    const fork = await d.sessions.create({
      ticket: original.ticket || undefined,
      summary: newName ?? `${baseName} (fork)`,
      repo: original.repo || undefined,
      flow: original.flow,
      compute_name: original.compute_name || undefined,
      workdir: original.workdir || undefined,
    });

    await d.sessions.update(fork.id, {
      stage: original.stage,
      status: "ready",
      group_name: original.group_name,
    });

    await d.events.log(fork.id, "session_forked", {
      stage: original.stage,
      actor: "user",
      data: { forked_from: sessionId },
    });

    hooks?.onCreated?.(fork.id);
    return { ok: true, sessionId: fork.id };
  }

  /**
   * Clone: deep copy -- same as fork PLUS claude_session_id for --resume.
   * The new session will resume the same Claude conversation.
   */
  async clone(sessionId: string, newName?: string, hooks?: LifecycleHooks): Promise<SessionOpResult> {
    const d = this.deps;
    const original = await d.sessions.get(sessionId);
    if (!original) return { ok: false, message: `Session ${sessionId} not found` };

    const baseName = original.summary || sessionId;
    const clone = await d.sessions.create({
      ticket: original.ticket || undefined,
      summary: newName ?? `${baseName} (clone)`,
      repo: original.repo || undefined,
      flow: original.flow,
      compute_name: original.compute_name || undefined,
      workdir: original.workdir || undefined,
    });

    await d.sessions.update(clone.id, {
      stage: original.stage,
      status: "ready",
      group_name: original.group_name,
      claude_session_id: original.claude_session_id,
    });

    await d.events.log(clone.id, "session_cloned", {
      stage: original.stage,
      actor: "user",
      data: { cloned_from: sessionId, claude_session_id: original.claude_session_id },
    });

    hooks?.onCreated?.(clone.id);
    return { ok: true, sessionId: clone.id };
  }
}
