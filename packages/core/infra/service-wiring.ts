/**
 * ServiceWiring -- early-boot side effects that must run before any
 * compute/HTTP service starts but after the container is built.
 *
 * Owns:
 *   - plugin registry (seed builtin executors, kick off user plugin load)
 *   - module-level event bus clear
 *   - OTLP / telemetry / rollback config
 *
 * Kept out of the DI factories because these are effects, not state.
 */
import type { AppContext } from "../app.js";
import type { PluginRegistry } from "../plugins/registry.js";
import { registerExecutor } from "../executor.js";
import { builtinExecutors, loadPluginExecutors } from "../executors/index.js";
import { configureOtlp } from "../observability/otlp.js";
import { configureTelemetry } from "../observability/telemetry.js";
import { eventBus } from "../hooks.js";
import { logWarn } from "../observability/structured-log.js";

export class ServiceWiring {
  constructor(
    private readonly app: AppContext,
    private readonly pluginRegistry: PluginRegistry,
  ) {}

  start(): void {
    for (const ex of builtinExecutors) {
      this.pluginRegistry.register({ kind: "executor", name: ex.name, impl: ex, source: "builtin" });
      registerExecutor(ex);
    }

    // fire-and-forget: plugin loading is best-effort, never blocks boot
    loadPluginExecutors(this.app.config.dirs.ark, (msg) => logWarn("general", `[plugins] ${msg}`))
      .then((plugins) => {
        for (const ex of plugins) {
          this.pluginRegistry.register({ kind: "executor", name: ex.name, impl: ex, source: "user" });
          registerExecutor(ex);
        }
      })
      .catch((e: any) => logWarn("general", `[plugins] loadPluginExecutors failed: ${e?.message ?? e}`));

    // Clear the module-level event bus in case a previous app instance
    // left handlers attached. AppContext.eventBus returns the same
    // singleton after this call; flip the ready flag so the accessor
    // stops throwing.
    eventBus.clear();
    this.app._markEventBusReady();

    configureOtlp(this.app.config.otlp);
    this.app.rollbackConfig = this.app.config.rollback;
    configureTelemetry(this.app.config.telemetry);
  }

  async stop(): Promise<void> {
    // Teardown in reverse of start. Session drain is handled by
    // SessionDrain (resolved LAST, disposed FIRST) so by the time we
    // reach ServiceWiring.stop, every running session is already drained.
    try {
      const { flush: flushTelemetry } = await import("../observability/telemetry.js");
      const { flushSpans, resetOtlp } = await import("../observability/otlp.js");
      await flushTelemetry();
      await flushSpans();
      resetOtlp();
    } catch {
      // telemetry flush is best-effort
    }

    eventBus.clear();
    this.app._markEventBusStopped();

    // The statusPollers cradle entry has its own awilix disposer that clears
    // every interval on container.dispose(); no need to kick it manually here
    // (and calling into the DI container during shutdown risks re-resolving
    // disposed dependencies). Left as a comment for the explicit contract.
  }
}
