/**
 * Hosted-mode dispatch: delegate to the tenant-aware scheduler + remote arkd.
 *
 * Scheduler is only wired in hosted mode; `deps.getScheduler()` returns null
 * in local mode, which causes the caller to fall through to the local
 * dispatch path.
 */

import { logDebug } from "../../observability/structured-log.js";
import type { DispatchDeps, DispatchResult } from "./types.js";
import type { Session } from "../../../types/index.js";

export class HostedDispatcher {
  constructor(private readonly deps: Pick<DispatchDeps, "sessions" | "events" | "getScheduler">) {}

  /**
   * Returns:
   *   - DispatchResult if we attempted scheduling (success or failure).
   *   - null if no scheduler is wired (local mode; caller falls through).
   */
  async dispatch(sessionId: string, session: Session, log: (msg: string) => void): Promise<DispatchResult | null> {
    const scheduler = this.deps.getScheduler();
    if (!scheduler) {
      logDebug("session", "Scheduler not available -- fall through to local dispatch");
      return null;
    }

    const tenantId = session.tenant_id ?? "default";
    log(`Scheduling session for tenant: ${tenantId}`);
    try {
      const worker = await scheduler.schedule(session, tenantId);
      log(`Dispatched to worker ${worker.id} (${worker.url})`);
      const { ArkdClient } = await import("../../../arkd/client.js");
      const client = new ArkdClient(worker.url);
      const sessionName = `ark-s-${sessionId}`;
      const script = `#!/bin/bash\necho "Dispatched session ${sessionId}"`;
      await client.launchAgent({
        sessionName,
        script,
        workdir: session.workdir ?? session.repo ?? ".",
      });
      await this.deps.sessions.update(sessionId, {
        status: "running",
        session_id: sessionName,
        compute_name: worker.compute_name,
      });
      await this.deps.events.log(sessionId, "dispatched_to_worker", {
        actor: "scheduler",
        data: { worker_id: worker.id, worker_url: worker.url, tenant_id: tenantId },
      });
      return { ok: true, launched: true, message: `Dispatched to worker ${worker.id}` };
    } catch (schedErr: any) {
      return { ok: false, message: schedErr.message ?? "Scheduling failed" };
    }
  }
}
