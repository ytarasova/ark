/**
 * TensorZeroLauncher -- container-managed wrapper around TensorZeroManager.
 *
 * TensorZero is an optional LLM gateway. When enabled in config, it runs
 * before the LLM Router (router uses `tensorZeroUrl` from this launcher).
 */
import type { ArkConfig } from "../config.js";
import type { TensorZeroManager } from "../router/tensorzero.js";
import { safeAsync } from "../safe.js";
import { logWarn } from "../observability/structured-log.js";

export class TensorZeroLauncher {
  private manager: TensorZeroManager | null = null;

  constructor(
    private readonly config: ArkConfig,
    private readonly opts: { skip?: boolean } = {},
  ) {}

  async start(): Promise<void> {
    if (this.opts.skip) return;
    if (!this.config.tensorZero?.enabled) return;

    await safeAsync("boot: start TensorZero", async () => {
      const { TensorZeroManager } = await import("../router/tensorzero.js");
      this.manager = new TensorZeroManager({
        port: this.config.tensorZero!.port,
        configDir: this.config.tensorZero!.configDir,
        anthropicKey: process.env.ANTHROPIC_API_KEY,
        openaiKey: process.env.OPENAI_API_KEY,
        geminiKey: process.env.GEMINI_API_KEY,
      });
      if (this.config.tensorZero!.autoStart) {
        await this.manager.start();
      }
    });
  }

  async stop(): Promise<void> {
    if (this.manager) {
      await this.manager.stop().catch((err) => {
        logWarn("general", `TensorZeroLauncher: manager stop failed during shutdown`, {
          error: err instanceof Error ? err.message : String(err),
        });
      });
      this.manager = null;
    }
  }

  /** Gateway URL, or null when not enabled. Consumed by RouterLauncher. */
  get url(): string | null {
    return this.manager?.url ?? null;
  }

  get instance(): TensorZeroManager | null {
    return this.manager;
  }
}
