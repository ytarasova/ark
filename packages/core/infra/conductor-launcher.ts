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
 */
import type { ArkConfig } from "../config.js";
import type { AppContext } from "../app.js";
import { safeAsync } from "../safe.js";

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
