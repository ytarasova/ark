/**
 * Checkpoint system for crash recovery.
 *
 * Saves session state snapshots as events in the events table (type "checkpoint").
 * When a long-running session crashes (machine restart, OOM, etc.), the last
 * checkpoint can be used to recover.
 */

import type { Session, Event } from "../../types/index.js";
import type { SessionRepository } from "../repositories/session.js";
import type { EventRepository } from "../repositories/event.js";
import * as tmux from "../infra/tmux.js";

// ── Types ──────────────────────────────────────────────────────────────────

export interface Checkpoint {
  sessionId: string;
  stage: string;
  status: string;
  claudeSessionId: string | null;
  tmuxSessionId: string | null;
  workdir: string | null;
  computeName: string | null;
  timestamp: string;
  data: Record<string, unknown>;
}

/** Narrow deps for the checkpoint functions -- just what they touch. */
export interface CheckpointDeps {
  sessions: SessionRepository;
  events: EventRepository;
}

// ── Save / Load ────────────────────────────────────────────────────────────

/** Save a checkpoint for a session. Stores full state snapshot as a checkpoint event. */
export async function saveCheckpoint(deps: CheckpointDeps, sessionId: string): Promise<void> {
  const session = await deps.sessions.get(sessionId);
  if (!session) return;

  const data: Record<string, unknown> = {
    stage: session.stage,
    status: session.status,
    claudeSessionId: session.claude_session_id,
    tmuxSessionId: session.session_id,
    workdir: session.workdir,
    computeName: session.compute_name,
    agent: session.agent,
    flow: session.flow,
    branch: session.branch,
    error: session.error,
    config: session.config,
  };

  await deps.events.log(sessionId, "checkpoint", { stage: session.stage ?? undefined, actor: "system", data });
}

/** Get the latest checkpoint for a session. */
export async function getCheckpoint(deps: CheckpointDeps, sessionId: string): Promise<Checkpoint | null> {
  const events = await deps.events.list(sessionId, { type: "checkpoint" });
  if (events.length === 0) return null;

  const latest = events[events.length - 1];
  return eventToCheckpoint(sessionId, latest);
}

/** List all checkpoints for a session, oldest first. */
export async function listCheckpoints(deps: CheckpointDeps, sessionId: string): Promise<Checkpoint[]> {
  const events = await deps.events.list(sessionId, { type: "checkpoint" });
  return events.map((e) => eventToCheckpoint(sessionId, e));
}

// ── Orphan detection ───────────────────────────────────────────────────────

/**
 * Find sessions that were running when the process died (no clean stop).
 * A session is orphaned if its status is "running" or "waiting" but its
 * tmux session no longer exists.
 *
 * Hosted mode: this boot-time scan must see sessions across every tenant,
 * so it uses the privileged `listAcrossTenants` read when available and
 * falls back to the tenant-scoped `list` for older repo shims. Handler code
 * must continue to use `list()` (tenant-scoped).
 */
export async function findOrphanedSessions(deps: Pick<CheckpointDeps, "sessions">): Promise<Session[]> {
  const scan = (filter: Parameters<SessionRepository["list"]>[0]) =>
    typeof (deps.sessions as SessionRepository & { listAcrossTenants?: typeof deps.sessions.list })
      .listAcrossTenants === "function"
      ? (
          deps.sessions as SessionRepository & {
            listAcrossTenants: (f?: Parameters<SessionRepository["list"]>[0]) => Promise<Session[]>;
          }
        ).listAcrossTenants(filter)
      : deps.sessions.list(filter);

  const running = await scan({ status: "running" });
  const waiting = await scan({ status: "waiting" });
  const candidates = [...running, ...waiting];

  return candidates.filter((session) => {
    if (!session.session_id) return true; // no tmux session recorded -- orphaned
    try {
      return !tmux.sessionExists(session.session_id);
    } catch {
      // tmux not available -- treat as orphaned
      return true;
    }
  });
}

// ── Recovery ───────────────────────────────────────────────────────────────

/**
 * Recover a session from its last checkpoint.
 *
 * 1. Load last checkpoint
 * 2. Reset session to "ready" status so it can be re-dispatched
 * 3. Preserve claude_session_id for --resume on next dispatch
 * 4. Log recovery event
 */
export async function recoverSession(
  deps: CheckpointDeps,
  sessionId: string,
): Promise<{ ok: boolean; message: string }> {
  const session = await deps.sessions.get(sessionId);
  if (!session) return { ok: false, message: `Session ${sessionId} not found` };

  const checkpoint = await getCheckpoint(deps, sessionId);

  // Build recovery fields
  const updates: Partial<Session> = {
    status: "ready",
    error: null,
    session_id: null, // clear dead tmux reference
  };

  // Restore stage from checkpoint if available
  if (checkpoint?.stage) {
    updates.stage = checkpoint.stage;
  }

  // Preserve claude_session_id for --resume (from checkpoint or current session)
  const claudeId = checkpoint?.claudeSessionId ?? session.claude_session_id;
  if (claudeId) {
    updates.claude_session_id = claudeId;
  }

  await deps.sessions.update(sessionId, updates);

  await deps.events.log(sessionId, "session_recovered", {
    stage: updates.stage ?? session.stage ?? undefined,
    actor: "system",
    data: {
      from_status: session.status,
      had_checkpoint: !!checkpoint,
      claude_session_id: claudeId,
    },
  });

  return {
    ok: true,
    message: checkpoint
      ? `Recovered from checkpoint (stage: ${checkpoint.stage})`
      : `Recovered to ready (no checkpoint, stage: ${session.stage})`,
  };
}

// ── Internal ───────────────────────────────────────────────────────────────

function eventToCheckpoint(sessionId: string, event: Event): Checkpoint {
  const d = event.data ?? {};
  return {
    sessionId,
    stage: (d.stage as string) ?? event.stage ?? "",
    status: (d.status as string) ?? "",
    claudeSessionId: (d.claudeSessionId as string) ?? null,
    tmuxSessionId: (d.tmuxSessionId as string) ?? null,
    workdir: (d.workdir as string) ?? null,
    computeName: (d.computeName as string) ?? null,
    timestamp: event.created_at,
    data: d,
  };
}
