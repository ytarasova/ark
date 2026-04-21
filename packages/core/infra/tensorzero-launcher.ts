/**
 * TensorZeroLauncher -- container-managed wrapper around TensorZeroManager.
 *
 * TensorZero is an optional LLM gateway. When enabled in config, it runs
 * before the LLM Router (router uses `tensorZeroUrl` from this launcher).
 */
import { join } from "path";
import type { ArkConfig } from "../config.js";
import type { TensorZeroManager } from "../router/tensorzero.js";
import { safeAsync } from "../safe.js";

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
      // Prefer the explicit configDir from yaml, else land under the ark
      // data dir. TensorZeroManager throws on empty configDir now -- the
      // previous `$HOME`/`/tmp` fallback wrote provider API keys to
      // world-readable paths on container hosts.
      const configDir = this.config.tensorZero!.configDir ?? join(this.config.arkDir, "tensorzero");
      this.manager = new TensorZeroManager({
        port: this.config.tensorZero!.port,
        configDir,
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
      await this.manager.stop().catch(() => {});
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
