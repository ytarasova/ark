/**
 * ServerPollers -- container-managed wrapper around `startPollers()`.
 *
 * The background pollers (schedule, PR review, PR merge, issue) were
 * previously started as part of the old ConductorLauncher.start() call.
 * Now that the conductor is merged into the server daemon, the pollers
 * are started here as a separate infra component so their lifecycle is
 * managed by the awilix container alongside the other infra launchers.
 *
 * Start order: after DB / repos / services (pollers access them via `app`).
 * Dispose order: reverse of start (awilix dispose runs in reverse resolution).
 */

import type { AppContext } from "../app.js";
import { startPollers } from "../services/pollers.js";

export class ServerPollers {
  private timers: Array<ReturnType<typeof setInterval>> = [];

  constructor(
    private readonly app: AppContext,
    private readonly opts: { skip?: boolean } = {},
  ) {}

  start(): void {
    if (this.opts.skip) return;
    // Issue label / auto-dispatch are CLI-level options (passed via conductor
    // start in the old model). They can be surfaced in AppConfig in a
    // follow-up; for now we start the schedule + PR pollers unconditionally.
    this.timers = startPollers(this.app, {});
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }
}
