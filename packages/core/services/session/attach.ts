/**
 * SessionAttachService -- decides how (or whether) to attach to a session.
 *
 * One question, one answer. Callers (CLI, web RPC handler) ask
 * `attachPlanFor(session)` and get back a discriminated `AttachPlan`.
 * They render or exec it; they do NOT make their own decisions about
 * compute_name, runtime.interactive, status, or session_id.
 *
 * The decision tree lives in ONE place:
 *
 *   - status is terminal (completed/failed/archived)?  -> "none"
 *   - no session_id (not yet dispatched)?              -> "none"
 *   - runtime.interactive === false (claude-agent)?    -> "tail"
 *   - everything else (tmux-based)                     -> "interactive"
 *
 * Each variant carries exactly the fields its consumer needs:
 *
 *   - `interactive`  carries the user-facing `command` (`ark session
 *     attach <id>`) the web UI shows AND the `transportCommand`
 *     (`tmux attach`, `aws ssm start-session`, `kubectl exec`) the CLI
 *     execs. They are different strings on purpose -- the web UI must
 *     not surface the raw transport, the CLI must not recurse into
 *     itself.
 *
 *   - `tail` carries the file paths to tail. The CLI tails them
 *     directly; the web UI shows an empty-state pointing to
 *     Conversation/Logs tabs.
 *
 *   - `none` carries a `reason` string. Both surfaces show it.
 */

import type { AppContext } from "../../app.js";
import type { Session } from "../../../types/index.js";
import { join } from "path";

export type AttachPlan =
  | {
      mode: "interactive";
      /** User-facing command shown in the web UI. Always `ark session attach <id>`. */
      command: string;
      /**
       * Transport command the CLI execs to drop the user into the live
       * pane. Built from the compute provider's `getAttachCommand` -- it
       * resolves to `tmux attach -t <pane>` for local, `aws ssm start-
       * session ...` for EC2, `kubectl exec ...` for k8s.
       */
      transportCommand: string;
      displayHint: string;
    }
  | {
      mode: "tail";
      /** Absolute path to the SDK transcript JSONL. */
      transcriptPath: string;
      /** Absolute path to the agent's stdio log. */
      stdioPath: string;
      /** UI hint -- where the live output actually appears. */
      displayHint: string;
      /** UI explanation for surfaces that can't tail (web Terminal tab). */
      reason: string;
    }
  | {
      mode: "none";
      reason: string;
    };

/**
 * Resolve the runtime definition driving the session's CURRENT stage.
 *
 * Runtime is per-stage: a session can move through implement on
 * `claude-agent`, then verify on `claude-code`. session.agent and
 * session.config.launch_executor both reflect the active stage's
 * runtime (rewritten on each stage advance), so reading them here gives
 * the active runtime, not a fossilised session-level one.
 *
 * Resolution order matches `resolveSessionExecutor`:
 *   1. session.config.launch_executor -- canonical, set by post-launch
 *      when the current stage was dispatched. Always wins when present.
 *   2. session.agent's runtime field -- legacy fallback for older rows.
 */
function resolveActiveRuntime(
  app: AppContext,
  session: Pick<Session, "config" | "agent">,
): { interactive?: boolean } | null {
  const cfg = session.config ?? null;
  const launchExecutor = (cfg as { launch_executor?: string } | null)?.launch_executor;
  if (launchExecutor) {
    const r = app.runtimes.get(launchExecutor);
    if (r) return r;
  }
  if (session.agent) {
    const agent = app.agents.get(session.agent);
    const runtimeName = (agent as { runtime?: string } | undefined)?.runtime;
    if (runtimeName) {
      const r = app.runtimes.get(runtimeName);
      if (r) return r;
    }
  }
  return null;
}

const TERMINAL_STATUSES = new Set<Session["status"]>(["completed", "failed", "archived"]);

export class SessionAttachService {
  constructor(private readonly app: AppContext) {}

  /**
   * Compute the AttachPlan for a session. Single decision point; no
   * caller branches on session fields directly.
   */
  async planFor(session: Session): Promise<AttachPlan> {
    if (TERMINAL_STATUSES.has(session.status)) {
      return {
        mode: "none",
        reason: `Session is ${session.status}; no live pane to attach to.`,
      };
    }
    if (!session.session_id) {
      return {
        mode: "none",
        reason: "Session has not been dispatched yet.",
      };
    }

    const runtime = resolveActiveRuntime(this.app, session);
    if (runtime?.interactive === false) {
      const tracksDir = this.app.config.dirs.tracks;
      return {
        mode: "tail",
        transcriptPath: join(tracksDir, session.id, "transcript.jsonl"),
        stdioPath: join(tracksDir, session.id, "stdio.log"),
        displayHint: "Live output is in the Conversation and Logs tabs.",
        reason: "This runtime runs as a plain process (no interactive terminal).",
      };
    }

    return {
      mode: "interactive",
      command: `ark session attach ${session.id}`,
      transportCommand: await this.resolveTransportCommand(session),
      displayHint: "Run this on the host where ark is installed:",
    };
  }

  private async resolveTransportCommand(session: Session): Promise<string> {
    if (session.compute_name) {
      const compute = await this.app.computes.get(session.compute_name);
      if (compute) {
        const computeImpl = this.app.getCompute(compute.compute_kind);
        const handle = computeImpl?.attachExistingHandle?.({
          name: compute.name,
          status: compute.status,
          config: (compute.config ?? {}) as Record<string, unknown>,
        });
        try {
          const parts = computeImpl && handle ? computeImpl.getAttachCommand(handle, session) : [];
          if (parts.length > 0) return parts.join(" ");
        } catch {
          // fall through to the local fallback
        }
      }
    }
    // Local fallback. session_id is non-null here because planFor() returned
    // mode="none" for the missing case above.
    const { attachCommand } = await import("../../infra/tmux.js");
    return attachCommand(session.session_id!);
  }
}
