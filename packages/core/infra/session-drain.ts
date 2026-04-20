/**
 * SessionDrain -- container-managed hook that drains in-flight session
 * dispatches + (optionally) stops every running session during shutdown.
 *
 * Registered so that its disposer runs FIRST during `container.dispose()`:
 * Lifecycle resolves it LAST on boot (after every launcher is up), which
 * means awilix disposes it first. That ordering matters -- draining
 * expects the conductor / arkd / sessions repo to still be alive.
 *
 * start() is intentionally a no-op; the work happens in stop().
 */
import type { AppContext } from "../app.js";
import { logDebug } from "../observability/structured-log.js";

export class SessionDrain {
  constructor(
    private readonly app: AppContext,
    private readonly opts: { cleanupOnShutdown?: boolean } = {},
  ) {}

  start(): void {
    // no-op: drain only fires on stop()
  }

  async stop(): Promise<void> {
    try {
      await this.app.sessionService.drainPendingDispatches();
    } catch {
      // best-effort: container may already be partially torn down
    }
    if (this.opts.cleanupOnShutdown) {
      try {
        await this.app.sessionService.stopAll();
      } catch {
        logDebug("general", "sessionService.stopAll failed during shutdown");
      }
    }
  }
}
