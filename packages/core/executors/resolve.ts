import type { Session } from "../../types/index.js";
import type { AppContext } from "../app.js";

/**
 * Resolve the executor name for a session.
 *
 * Single source of truth for "which runtime owns this session". Consult
 * order:
 *   1. `session.config.launch_executor` -- canonical, set by post-launch
 *      when the dispatcher resolves the runtime. Always wins when present.
 *   2. The resolved agent definition's `runtime` field -- legacy fallback
 *      for sessions dispatched before post-launch started writing
 *      launch_executor. Read via the AgentStore so name aliases (the
 *      May 2026 rename) are honoured.
 *   3. `null` -- caller decides what to do (skip, error, prompt user).
 *
 * Defaulting to a hardcoded "claude-code" is the bug pattern this helper
 * exists to prevent. Every consumer needs the SAME answer for the same
 * session, regardless of which layer is asking.
 */
export async function resolveSessionExecutor(app: AppContext, session: Session): Promise<string | null> {
  const cfg = session.config as Record<string, unknown> | null;
  const launch = cfg?.launch_executor;
  if (typeof launch === "string" && launch.length > 0) return launch;

  if (session.agent) {
    try {
      const agentDef = await app.agents.get(session.agent);
      const runtime = (agentDef as { runtime?: string } | undefined)?.runtime;
      if (typeof runtime === "string" && runtime.length > 0) return runtime;
    } catch {
      // Agent definition missing from store -- fall through.
    }
  }
  return null;
}
