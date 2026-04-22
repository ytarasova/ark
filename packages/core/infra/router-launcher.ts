/**
 * RouterLauncher -- container-managed wrapper around `startRouter()`.
 *
 * The LLM Router is optional (gated on `config.router.enabled +
 * autoStart`). When a TensorZero gateway is running, router dispatches
 * go through it; otherwise router talks directly to provider APIs.
 *
 * Depends on `tensorZeroLauncher` for the optional gateway URL and on
 * `usageRecorder` so router usage events persist as cost rows.
 */
import type { ArkConfig } from "../config.js";
import type { UsageRecorder } from "../observability/usage.js";
import type { TensorZeroLauncher } from "./tensorzero-launcher.js";
import type { RouterServer } from "../../router/server.js";
import { safeAsync } from "../safe.js";

export class RouterLauncher {
  private server: RouterServer | null = null;

  constructor(
    private readonly config: ArkConfig,
    private readonly usageRecorder: UsageRecorder,
    private readonly tensorZero: TensorZeroLauncher,
    private readonly opts: { skip?: boolean } = {},
  ) {}

  async start(): Promise<void> {
    if (this.opts.skip) return;
    if (!this.config.router.enabled || !this.config.router.autoStart) return;

    await safeAsync("boot: start router", async () => {
      const { loadRouterConfig, startRouter } = await import("../../router/index.js");
      const routerConfig = loadRouterConfig({
        port: parseInt(this.config.router.url.split(":").pop() ?? "8430", 10),
        policy: this.config.router.policy,
      });
      if (routerConfig.providers.length === 0) return;

      const tensorZeroUrl = this.tensorZero.url ?? undefined;
      this.server = startRouter(routerConfig, {
        tensorZeroUrl,
        onUsage: (event) => {
          this.usageRecorder.record({
            sessionId: "router",
            model: event.model,
            provider: event.provider,
            usage: { input_tokens: event.input_tokens, output_tokens: event.output_tokens },
          });
        },
      });
    });
  }

  stop(): void {
    if (this.server) {
      this.server.stop();
      this.server = null;
    }
  }

  get instance(): RouterServer | null {
    return this.server;
  }
}
