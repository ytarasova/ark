/**
 * ArkdLauncher -- container-managed wrapper around `startArkd()`.
 *
 * Arkd is the universal agent daemon that runs alongside every compute
 * target. Agents POST reports here; arkd forwards to the conductor.
 *
 * Depends on the conductor being ready so it can point its default
 * forwarding URL at it. The Lifecycle registers `conductor` before
 * `arkd` so the URL is routable when arkd starts accepting reports.
 */
import type { ArkConfig } from "../config.js";
import { safeAsync } from "../safe.js";

export interface ArkdHandle {
  stop(): void;
  setConductorUrl(url: string): void;
}

export class ArkdLauncher {
  private handle: ArkdHandle | null = null;

  constructor(
    private readonly config: ArkConfig,
    private readonly opts: { skip?: boolean } = {},
  ) {}

  async start(): Promise<void> {
    if (this.opts.skip) return;
    await safeAsync("boot: start arkd", async () => {
      const { startArkd } = await import("../../arkd/server.js");
      const conductorUrl = `http://localhost:${this.config.conductorPort}`;
      this.handle = startArkd(this.config.arkdPort ?? 19300, { conductorUrl, quiet: true });
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
