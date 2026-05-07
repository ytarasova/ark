/**
 * ConductorLauncher -- container-managed wrapper around `startConductor()`.
 *
 * The conductor hosts the HTTP API consumed by agents (reports, channel
 * deliveries, hooks, worker/tenant admin). Registering it in the DI container
 * means boot/shutdown ordering is managed by awilix instead of an inline
 * block in `AppContext.boot`.
 *
 * Start order: after DB / repos / services (it accesses them via `app`).
 * Dispose order: reverse of start (awilix dispose runs in reverse resolution).
 *
 * NOTE: the old conductor is being collapsed into the server daemon (Phase E).
 * During the transition, the launcher skips binding when the configured port
 * is 19400 (the merged conductor+server port) to avoid a double-bind with the
 * ArkServer WebSocket listener that claims the same port. Users who explicitly
 * set a different port retain the old conductor for compatibility.
 */
import type { ArkConfig } from "../config.js";
import type { AppContext } from "../app.js";
import { safeAsync } from "../safe.js";
import { DEFAULT_CONDUCTOR_PORT } from "../constants.js";
import { logInfo } from "../observability/structured-log.js";

export interface ConductorHandle {
  stop(): void;
}

export class ConductorLauncher {
  private handle: ConductorHandle | null = null;

  constructor(
    private readonly app: AppContext,
    private readonly config: ArkConfig,
    private readonly opts: { skip?: boolean } = {},
  ) {}

  async start(): Promise<void> {
    if (this.opts.skip) return;
    // Guard: the old conductor is being merged into the server daemon (Phase E).
    // When the port equals the new merged default (19400) the ArkServer already
    // owns that port -- starting the old conductor here would double-bind.
    if (this.config.ports.conductor === DEFAULT_CONDUCTOR_PORT) {
      logInfo("conductor", "skipping legacy conductor -- port 19400 is owned by the server daemon");
      return;
    }
    await safeAsync("boot: start conductor", async () => {
      const { startConductor } = await import("../conductor/server/conductor.js");
      this.handle = startConductor(this.app, this.config.ports.conductor, { quiet: true });
    });
  }

  stop(): void {
    if (this.handle) {
      this.handle.stop();
      this.handle = null;
    }
  }

  get running(): boolean {
    return this.handle !== null;
  }
}
