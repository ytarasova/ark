/**
 * Pre-launch guards + short-circuits.
 *
 * Functions here fire before we commit to agent launch:
 *   - validateSessionForDispatch: status / stage / compute_name preconditions
 *   - maybeHandleActionStage:    short-circuit `action:` stages in-process
 *   - cloneRemoteRepoIfNeeded:   shallow-clone session.config.remoteRepo on first
 *                                 dispatch when no local workdir exists yet
 *   - checkPromptInjection:      scan session.summary, log + optionally abort
 *
 * All helpers are pure functions taking a narrow `DispatchDeps`-shaped object so
 * they're trivially unit-testable and don't widen the dispatcher class surface.
 */

import { mkdirSync } from "fs";
import { join } from "path";
import { promisify } from "util";
import { execFile } from "child_process";

import { logWarn } from "../../observability/structured-log.js";
import { detectInjection } from "../../session/prompt-guard.js";
import type { DispatchDeps, DispatchResult } from "./types.js";
import type { Session } from "../../../types/index.js";

const execFileAsync = promisify(execFile);

/**
 * Validate a session is ready to dispatch. Returns null when dispatch may
 * proceed; otherwise returns the terminal DispatchResult to propagate.
 *
 * Caller MUST check for a non-null return and bail. The session row itself is
 * returned alongside so callers don't re-fetch.
 */
export async function validateSessionForDispatch(
  deps: Pick<DispatchDeps, "sessions" | "computes">,
  sessionId: string,
): Promise<{ session: Session; early?: undefined } | { session?: undefined; early: DispatchResult }> {
  const session = await deps.sessions.get(sessionId);
  if (!session) return { early: { ok: false, message: `Session ${sessionId} not found` } };

  if (session.status === "running" && session.session_id) {
    return { early: { ok: true, message: `Already running (${session.session_id})` } };
  }
  if (session.status !== "ready" && session.status !== "blocked") {
    return {
      early: {
        ok: false,
        message: `Not ready (status: ${session.status}). Stop it first, or wait for it to finish.`,
      },
    };
  }

  if (!session.stage) {
    return { early: { ok: false, message: "No current stage. The session may have completed its flow." } };
  }

  if (session.compute_name && !(await deps.computes.get(session.compute_name))) {
    return {
      early: {
        ok: false,
        message: `Compute '${session.compute_name}' not found. Delete and recreate the session.`,
      },
    };
  }

  return { session };
}

/**
 * Short-circuit handling for `action:` stages. Returns a DispatchResult when
 * the stage is an action (regardless of success/failure) so the caller can
 * return immediately; returns null when the stage is not an action.
 */
export async function maybeHandleActionStage(
  deps: Pick<DispatchDeps, "sessions" | "getStageAction" | "executeAction" | "mediateStageHandoff">,
  session: Session,
): Promise<DispatchResult | null> {
  const sessionId = session.id;
  const stage = session.stage!;
  const earlyAction = deps.getStageAction(session.flow, stage);
  if (earlyAction.type !== "action") return null;

  const result = await deps.executeAction(sessionId, earlyAction.action ?? "");
  if (!result.ok) {
    await deps.sessions.update(sessionId, {
      status: "failed",
      error: `Action '${earlyAction.action}' failed: ${result.message.slice(0, 200)}`,
    });
    return { ok: false, message: result.message };
  }
  const postAction = await deps.sessions.get(sessionId);
  if (postAction?.status === "ready") {
    await deps.mediateStageHandoff(sessionId, { autoDispatch: true, source: "dispatch_action" });
  }
  return { ok: true, message: `Executed action '${earlyAction.action}'` };
}

/**
 * Clone a remote repo referenced in session.config.remoteRepo into the
 * worktrees dir. Noop when no remoteRepo or when session.workdir is already
 * set. Mutates the in-memory session object so callers don't need to re-fetch.
 */
export async function cloneRemoteRepoIfNeeded(
  deps: Pick<DispatchDeps, "sessions" | "events" | "config">,
  session: Session,
  log: (msg: string) => void,
): Promise<{ ok: true } | { ok: false; message: string }> {
  if (!session.config?.remoteRepo || session.workdir) return { ok: true };
  const sessionId = session.id;
  const remoteUrl = session.config.remoteRepo as string;
  log(`Cloning remote repo: ${remoteUrl}`);
  try {
    const tmpDir = join(deps.config.dirs.ark, "worktrees", sessionId);
    mkdirSync(tmpDir, { recursive: true });
    await execFileAsync("git", ["clone", "--depth", "1", remoteUrl, tmpDir], { timeout: 120_000 });
    await deps.sessions.update(sessionId, { workdir: tmpDir });
    const updated = await deps.sessions.get(sessionId);
    if (updated) (session as { workdir: string | null }).workdir = updated.workdir;
    log(`Cloned remote repo to ${tmpDir}`);
    await deps.events.log(sessionId, "remote_repo_cloned", {
      actor: "system",
      data: { url: remoteUrl, dir: tmpDir },
    });
    return { ok: true };
  } catch (e: any) {
    return { ok: false, message: `Failed to clone remote repo: ${e.message}` };
  }
}

/**
 * Prompt-injection scan on session.summary. High-severity matches abort
 * dispatch; lower severity only logs a warning. Errors during detection are
 * swallowed so a broken regex or guard helper never blocks dispatch.
 */
export async function checkPromptInjection(
  deps: Pick<DispatchDeps, "events">,
  session: Session,
): Promise<{ blocked: boolean; message?: string }> {
  try {
    const injection = detectInjection(session.summary ?? "");
    if (injection.severity === "high") {
      await deps.events.log(session.id, "prompt_injection_blocked", {
        actor: "system",
        data: { patterns: injection.patterns, context: "dispatch" },
      });
      return { blocked: true, message: "Dispatch blocked: potential prompt injection in task summary" };
    }
    if (injection.detected) {
      await deps.events.log(session.id, "prompt_injection_warning", {
        actor: "system",
        data: { patterns: injection.patterns, severity: injection.severity, context: "dispatch" },
      });
    }
  } catch (err: any) {
    // Don't disable injection blocking silently if the regex throws --
    // surface so a bug here is visible in the structured log.
    logWarn("session", `prompt-injection guard failed: ${err?.message ?? err}`);
  }
  return { blocked: false };
}
