/**
 * SessionTerminator -- stop, delete, undelete, cleanup-on-terminal.
 * Extracted from the old session-lifecycle.ts.
 */

import type { Session, Compute } from "../../../types/index.js";
import type { ComputeProvider } from "../../compute/types.js";
import type { ComputeTarget } from "../../compute/core/compute-target.js";
import type { SessionLifecycleDeps } from "./types.js";
import * as claude from "../../claude/claude.js";
import { killSessionAsync } from "../../infra/tmux.js";
import { safeAsync } from "../../safe.js";
import { saveCheckpoint } from "../../session/checkpoint.js";
import { logDebug, logError, logInfo } from "../../observability/structured-log.js";
import { recordEvent } from "../../observability.js";
import { emitSessionSpanEnd, emitStageSpanEnd, flushSpans } from "../../observability/otlp.js";

export class SessionTerminator {
  constructor(private readonly deps: SessionLifecycleDeps) {}

  /** Safely run a provider method for a session. */
  private async withProvider(
    session: Session,
    label: string,
    fn: (provider: ComputeProvider, compute: Compute) => Promise<void>,
  ): Promise<boolean> {
    const { provider, compute } = await this.deps.resolveProvider(session);
    if (!provider || !compute) return false;
    return safeAsync(label, () => fn(provider, compute));
  }

  /**
   * Invoke a ComputeTarget method for a session when the compute row maps to
   * a registered (compute, runtime) pair. Returns true on success, false when
   * no target is available.
   */
  private async withComputeTarget(
    session: Session,
    label: string,
    fn: (target: ComputeTarget, compute: Compute) => Promise<void>,
  ): Promise<boolean> {
    try {
      const { target, compute } = await this.deps.resolveComputeTarget(session);
      if (!target || !compute) return false;
      return safeAsync(label, () => fn(target, compute));
    } catch (e: any) {
      logError("session", `${label}: resolveComputeTarget failed: ${e?.message ?? e}`);
      return false;
    }
  }

  /**
   * Kill the agent process via the new `Isolation.attachAgent` path. Resolves
   * the ComputeTarget from the session, rehydrates the compute handle from
   * the persisted compute row, attaches an AgentHandle bound to the live
   * arkd client, and calls `agent.kill()`. Returns true on success, false
   * when the target is unavailable, the compute can't be rehydrated, or
   * arkd refuses the kill (caller logs and falls through).
   */
  private async killAgentViaTarget(session: Session): Promise<boolean> {
    if (!session.session_id) return false;
    return this.withComputeTarget(session, `killAgent ${session.id}`, async (target, computeRow) => {
      const computeHandle = target.compute.attachExistingHandle?.({
        name: computeRow.name,
        status: computeRow.status,
        config: computeRow.config ?? {},
      });
      if (!computeHandle) {
        // Compute row hasn't been provisioned yet (no instance_id / pod_name /
        // vm_id stored), so there's no arkd to talk to. The cleanupSession
        // pass that follows handles the row-level teardown.
        logDebug("session", `killAgent ${session.id}: compute not yet provisioned, skipping kill`);
        return;
      }
      const agent = target.isolation.attachAgent(target.compute, computeHandle, session.session_id!);
      await agent.kill();
    });
  }

  async stop(sessionId: string, opts?: { force?: boolean }): Promise<{ ok: boolean; message: string }> {
    const d = this.deps;
    const session = await d.sessions.get(sessionId);
    if (!session) return { ok: false, message: `Session ${sessionId} not found` };

    if (!opts?.force && ["stopped", "completed", "failed"].includes(session.status) && !session.session_id) {
      return { ok: true, message: "Already stopped" };
    }

    // Kill tracked process trees before blunt tmux/provider kill
    try {
      const { killProcessTree } = await import("../../executors/process-tree.js");
      const launchPid = session.config?.launch_pid as number | undefined;
      if (launchPid) await killProcessTree(launchPid);
      const tree = (session.config?.process_tree ?? []) as Array<{ pid: number }>;
      for (const entry of tree) {
        if (entry.pid) await killProcessTree(entry.pid);
      }
    } catch {
      logDebug("session", "fall through to tmux kill");
    }

    // Kill the agent via the new ComputeTarget path: `target.isolation.attachAgent`
    // rebuilds an AgentHandle from the persisted session_id and calls
    // `agent.kill()` against the live arkd. The provider-side `cleanupSession`
    // path stays on the legacy registry until that op also moves to the
    // new world. Local-tmux fallback below is ONLY safe when no provider
    // resolves -- when a target exists but its kill failed (e.g. arkd
    // unreachable on EC2), running `tmux kill-session` against the
    // conductor's local daemon does nothing useful and silently masks the
    // real failure (#422 / #425 family).
    const { provider, compute } = await d.resolveProvider(session);
    if (provider && compute) {
      const killOk = await this.killAgentViaTarget(session);
      if (!killOk) {
        logError(
          "session",
          `stop ${sessionId}: target-based killAgent failed; agent on worker may still be running. ` +
            `Status will still flip to 'stopped' so the dashboard reflects operator intent.`,
        );
      }
      await safeAsync(`stop ${sessionId}: cleanupSession`, async () => {
        await provider.cleanupSession(compute, session);
      });
    } else if (session.session_id) {
      // No provider resolved -- legacy local-only sessions or test fixtures.
      // Use local tmux. Safe here because absence of provider implies the
      // tmux pane is on the conductor's host.
      await killSessionAsync(session.session_id);
    }

    await this.withComputeTarget(session, `stop ${sessionId}: shutdown runtime`, async (target, c) => {
      await target.shutdown({ kind: target.compute.kind, name: c.name, meta: {} });
    });

    try {
      d.statusPollers.stop(sessionId);
    } catch {
      logDebug("session", "poller may not be running -- safe to ignore");
    }

    // Checkpoint before state transition. saveCheckpoint takes a narrow
    // {sessions, events} deps shape -- the Cradle-style refactor lets us
    // pass the repos directly without dragging AppContext through.
    await saveCheckpoint({ sessions: d.sessions, events: d.events }, sessionId);

    try {
      const compute = session.compute_name ? await d.computes.get(session.compute_name) : null;
      await d.deleteCredsSecret(session, compute);
    } catch (e: any) {
      logError("session", `stop ${sessionId}: creds secret cleanup: ${e?.message ?? e}`);
    }

    if (session.workdir) {
      try {
        claude.removeSettings(session.workdir);
      } catch (e: any) {
        logError("session", `stop ${sessionId}: removeSettings: ${e?.message ?? e}`);
      }
      try {
        claude.removeChannelConfig(session.workdir);
      } catch (e: any) {
        logError("session", `stop ${sessionId}: removeChannelConfig: ${e?.message ?? e}`);
      }
    }

    await d.removeWorktree(session);

    // Emit session_cleaned for the stopped path (worktree was just removed above).
    // The event acts as an idempotency guard so a later cleanupSession call is a no-op.
    await d.events.log(sessionId, "session_cleaned", {
      actor: "system",
      data: { worktree_path: null, worktree_removed: true, via: "stop" },
    });

    await d.sessions.update(sessionId, { status: "stopped", error: null, session_id: null });
    await d.events.log(sessionId, "session_stopped", {
      stage: session.stage,
      actor: "user",
      data: { session_id: session.session_id, agent: session.agent },
    });

    recordEvent({ type: "session_end", sessionId, data: { status: "stopped" } });

    try {
      await d.gcComputeIfTemplate(session.compute_name);
    } catch (e: any) {
      logDebug("session", `compute gc on stop ${sessionId}: ${e?.message ?? e}`);
    }

    emitStageSpanEnd(sessionId, { status: "stopped" });
    emitSessionSpanEnd(sessionId, { status: "stopped" });
    flushSpans();

    return { ok: true, message: "Session stopped" };
  }

  async deleteSession(sessionId: string): Promise<{ ok: boolean; message: string }> {
    const d = this.deps;
    const session = await d.sessions.get(sessionId);
    if (!session) return { ok: false, message: `Session ${sessionId} not found` };

    // Same shape as stop(): only fall back to local tmux when there's truly
    // no provider for this session. Kill goes through the new ComputeTarget
    // path; `cleanupSession` (worktree dir, on-host artefacts) still goes
    // through the legacy provider until that op moves to the new world.
    const { provider, compute } = await d.resolveProvider(session);
    if (provider && compute) {
      const killOk = await this.killAgentViaTarget(session);
      if (!killOk) {
        logError(
          "session",
          `delete ${sessionId}: target-based killAgent failed; agent on worker may still be running. ` +
            `DB row will still be deleted so the dashboard reflects operator intent.`,
        );
      }
      await safeAsync(`delete ${sessionId}: cleanupSession`, async () => {
        await provider.cleanupSession(compute, session);
      });
    } else if (session.session_id) {
      await killSessionAsync(session.session_id);
    }

    if (session.workdir) {
      try {
        claude.removeSettings(session.workdir);
      } catch (e: any) {
        logError("session", `delete ${sessionId}: removeSettings: ${e?.message ?? e}`);
      }
      try {
        claude.removeChannelConfig(session.workdir);
      } catch (e: any) {
        logError("session", `delete ${sessionId}: removeChannelConfig: ${e?.message ?? e}`);
      }
    }

    try {
      const compute = session.compute_name ? await d.computes.get(session.compute_name) : null;
      await d.deleteCredsSecret(session, compute);
    } catch (e: any) {
      logError("session", `delete ${sessionId}: creds secret cleanup: ${e?.message ?? e}`);
    }

    await d.removeWorktree(session);

    try {
      const { removeRecording } = await import("../../recordings.js");
      removeRecording(d.config.dirs.ark, sessionId);
    } catch {
      logInfo("session", "non-fatal");
    }

    await d.sessions.softDelete(sessionId);
    await d.events.log(sessionId, "session_deleted", { actor: "user" });

    return { ok: true, message: "Session deleted (undo available for 90s)" };
  }

  async undeleteSession(sessionId: string): Promise<{ ok: boolean; message: string }> {
    const d = this.deps;
    const restored = await d.sessions.undelete(sessionId);
    if (!restored) return { ok: false, message: `Session ${sessionId} not found or not deleted` };

    await d.events.log(sessionId, "session_undeleted", { actor: "user" });
    return { ok: true, message: `Session restored (status: ${restored.status})` };
  }

  async cleanupOnTerminal(sessionId: string): Promise<void> {
    const d = this.deps;
    const session = await d.sessions.get(sessionId);
    if (!session) return;
    await this.withProvider(session, `cleanup ${sessionId}`, (p, c) => p.cleanupSession(c, session));
    try {
      const compute = session.compute_name ? await d.computes.get(session.compute_name) : null;
      await d.deleteCredsSecret(session, compute);
    } catch (e: any) {
      logError("session", `cleanupOnTerminal ${sessionId}: creds secret cleanup: ${e?.message ?? e}`);
    }
  }
}
