/**
 * MetricsPoller -- background poller that refreshes compute metrics.
 *
 * Extracted from the old inline `_startMetricsPoller` in app.ts. Runs
 * every 30s and asks each registered compute to pollMetrics.
 */
import type { AppContext } from "../app.js";
import { safeAsync } from "../safe.js";

export class MetricsPoller {
  private handle: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly app: AppContext,
    private readonly opts: { skip?: boolean; intervalMs?: number } = {},
  ) {}

  start(): void {
    if (this.opts.skip) return;
    if (this.handle) return;
    const intervalMs = this.opts.intervalMs ?? 30_000;
    this.handle = setInterval(async () => {
      await safeAsync("metrics: poll computes", async () => {
        const computes = (await this.app.computes?.list({ status: "running" })) ?? [];
        for (const c of computes) {
          await safeAsync(`metrics: poll compute "${c.name}"`, async () => {
            const compute = (await import("../../compute/index.js")) as Record<string, unknown>;
            if (typeof compute.pollMetrics === "function") {
              await (compute.pollMetrics as (name: string) => Promise<void>)(c.name);
            }
          });
        }
      });
    }, intervalMs);
  }

  stop(): void {
    if (this.handle) {
      clearInterval(this.handle);
      this.handle = null;
    }
  }

  get running(): boolean {
    return this.handle !== null;
  }
}
