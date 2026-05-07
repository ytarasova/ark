/**
 * Channel delivery helper -- routes a payload to a session's channel,
 * preferring arkd when available and falling back to direct HTTP.
 *
 * Extracted from `conductor.ts` so integrations that need to steer a session
 * (pr-poller, github-pr, conductor relay endpoint) can import a small module
 * instead of pulling in the full Conductor class file.
 */

import type { Session } from "../../../types/index.js";
import type { AppContext } from "../../app.js";
import { ArkdClient } from "../../../arkd/client/index.js";
import { logDebug } from "../../observability/structured-log.js";
import { DEFAULT_CHANNEL_BASE_URL } from "../../constants.js";

/**
 * Deliver a message to a session's channel, using arkd if available.
 * Falls back to direct HTTP to the channel port for local sessions.
 *
 * The caller passes the AppContext explicitly -- there is no module-level
 * singleton. For tenant-scoped sessions the caller can pre-scope the app.
 */
export async function deliverToChannel(
  app: AppContext,
  targetSession: Session,
  channelPort: number,
  payload: Record<string, unknown>,
): Promise<void> {
  // Try arkd delivery first (works for both local and remote). Resolve the
  // arkd URL via the new ComputeTarget API: `target.compute.getArkdUrl(handle)`.
  // No legacy registry hop, no per-session port (this delivery path only
  // needs the compute-level arkd URL; the per-session SSM tunnel lookup
  // lives in `worktree/pr.ts` for the action-stage RPC path).
  const computeName = targetSession.compute_name || "local";
  const tenantApp = targetSession.tenant_id ? app.forTenant(targetSession.tenant_id) : app;
  const compute = await tenantApp.computes.get(computeName);
  if (compute) {
    const computeImpl = tenantApp.getCompute(compute.compute_kind);
    if (computeImpl && computeImpl.attachExistingHandle) {
      const handle = computeImpl.attachExistingHandle({
        name: compute.name,
        status: compute.status,
        config: (compute.config ?? {}) as Record<string, unknown>,
      });
      if (handle) {
        try {
          const arkdUrl = computeImpl.getArkdUrl(handle);
          const client = new ArkdClient(arkdUrl);
          const result = await client.channelDeliver({ channelPort, payload });
          if (result.delivered) return;
        } catch {
          logDebug("conductor", "arkd not available -- fall through to direct HTTP");
        }
      }
    }
  }

  // Fallback: direct HTTP to channel port (local only)
  try {
    await fetch(`${DEFAULT_CHANNEL_BASE_URL}:${channelPort}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch {
    logDebug("conductor", "channel not reachable -- expected when agent hasn't started channel yet");
  }
}
