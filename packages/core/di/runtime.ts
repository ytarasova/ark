/**
 * DI registrations for runtime-adjacent singletons:
 *   - Pricing registry (model cost table)
 *   - Usage recorder (token accounting, depends on pricing)
 *   - Transcript parser registry (polymorphic, one per agent tool)
 *   - Plugin registry (executors + pluggable compute providers)
 *   - Snapshot store (FS-backed by default, swappable for hosted deployments)
 *
 * Also owns every infra launcher (conductor, arkd, router, pollers, etc.)
 * and the top-level `Lifecycle` orchestrator. Launchers register their
 * `stop()` as awilix disposers so `container.dispose()` tears everything
 * down in reverse resolution order.
 */

import { asFunction, Lifetime } from "awilix";
import { join } from "path";
import type { AppContainer, AppBootOptions } from "../container.js";
import type { IDatabase } from "../database/index.js";
import type { ArkConfig } from "../config.js";
import type { AppContext } from "../app.js";
import type { PluginRegistry } from "../plugins/registry.js";
import type { UsageRecorder } from "../observability/usage.js";
import type { TensorZeroLauncher as TensorZeroLauncherType } from "../infra/tensorzero-launcher.js";
import { PricingRegistry } from "../observability/pricing.js";
import { UsageRecorder as UsageRecorderCtor } from "../observability/usage.js";
import { TranscriptParserRegistry } from "../runtimes/transcript-parser.js";
import { ClaudeTranscriptParser } from "../runtimes/claude/parser.js";
import { CodexTranscriptParser } from "../runtimes/codex/parser.js";
import { GeminiTranscriptParser } from "../runtimes/gemini/parser.js";
import { createPluginRegistry } from "../plugins/registry.js";
import { FsSnapshotStore } from "../../compute/core/snapshot-store-fs.js";
import type { SessionRepository } from "../repositories/session.js";
import { Lifecycle } from "../lifecycle.js";
import { ServiceWiring } from "../infra/service-wiring.js";
import { ComputeProvidersBoot } from "../infra/compute-providers-boot.js";
import { TensorZeroLauncher } from "../infra/tensorzero-launcher.js";
import { RouterLauncher } from "../infra/router-launcher.js";
import { ConductorLauncher } from "../infra/conductor-launcher.js";
import { ArkdLauncher } from "../infra/arkd-launcher.js";
import { MetricsPoller } from "../infra/metrics-poller.js";
import { MaintenancePollers } from "../infra/maintenance-pollers.js";
import { SignalHandlers } from "../infra/signal-handlers.js";
import { StaleStateDetector } from "../infra/stale-state-detector.js";
import { SessionDrain } from "../infra/session-drain.js";
import { StatusPollerRegistry } from "../executors/status-poller.js";

/**
 * Register runtime singletons: pricing, usage recorder, transcript parsers,
 * plugin registry, snapshot store, infra launchers, lifecycle orchestrator.
 */
export function registerRuntime(container: AppContainer): void {
  container.register({
    pricing: asFunction(
      () => {
        const reg = new PricingRegistry();
        // Non-blocking remote refresh -- failures are fine, we have defaults.
        reg.refreshFromRemote().catch(() => {});
        return reg;
      },
      { lifetime: Lifetime.SINGLETON },
    ),

    usageRecorder: asFunction(
      (c: { db: IDatabase; pricing: PricingRegistry }) => new UsageRecorderCtor(c.db, c.pricing),
      {
        lifetime: Lifetime.SINGLETON,
      },
    ),

    transcriptParsers: asFunction(
      (c: { sessions: SessionRepository }) => {
        const registry = new TranscriptParserRegistry();
        // Claude parser uses session.claude_session_id (set at launch via
        // --session-id) to construct the exact transcript path. The
        // sessionIdLookup bridges workdir -> stored claude_session_id by
        // querying the session repo.
        registry.register(
          new ClaudeTranscriptParser(undefined, (workdir) => {
            try {
              const sessions = c.sessions.list({ limit: 50 });
              const match = sessions.find((s) => s.workdir === workdir && s.claude_session_id);
              return match?.claude_session_id ?? null;
            } catch {
              return null;
            }
          }),
        );
        registry.register(new CodexTranscriptParser());
        registry.register(new GeminiTranscriptParser());
        return registry;
      },
      { lifetime: Lifetime.SINGLETON },
    ),

    pluginRegistry: asFunction(() => createPluginRegistry(), { lifetime: Lifetime.SINGLETON }),

    statusPollers: asFunction(() => new StatusPollerRegistry(), {
      lifetime: Lifetime.SINGLETON,
      dispose: (r: StatusPollerRegistry) => r.dispose(),
    }),

    snapshotStore: asFunction((c: { config: ArkConfig }) => new FsSnapshotStore(join(c.config.arkDir, "snapshots")), {
      lifetime: Lifetime.SINGLETON,
    }),

    // ── Infra launchers (every one has start/stop; disposers tear down) ─

    serviceWiring: asFunction(
      (c: { app: AppContext; pluginRegistry: PluginRegistry }) => new ServiceWiring(c.app, c.pluginRegistry),
      {
        lifetime: Lifetime.SINGLETON,
        dispose: async (s) => {
          await s.stop();
        },
      },
    ),

    computeProvidersBoot: asFunction((c: { app: AppContext }) => new ComputeProvidersBoot(c.app), {
      lifetime: Lifetime.SINGLETON,
      // no-op stop -- registrations are idempotent map entries
    }),

    tensorZeroLauncher: asFunction(
      (c: { config: ArkConfig; bootOptions: AppBootOptions }) =>
        new TensorZeroLauncher(c.config, { skip: c.bootOptions.skipConductor }),
      {
        lifetime: Lifetime.SINGLETON,
        dispose: async (s) => {
          await s.stop();
        },
      },
    ),

    routerLauncher: asFunction(
      (c: {
        config: ArkConfig;
        usageRecorder: UsageRecorder;
        tensorZeroLauncher: TensorZeroLauncherType;
        bootOptions: AppBootOptions;
      }) => new RouterLauncher(c.config, c.usageRecorder, c.tensorZeroLauncher, { skip: c.bootOptions.skipConductor }),
      {
        lifetime: Lifetime.SINGLETON,
        dispose: (s) => s.stop(),
      },
    ),

    conductorLauncher: asFunction(
      (c: { app: AppContext; config: ArkConfig; bootOptions: AppBootOptions }) =>
        new ConductorLauncher(c.app, c.config, { skip: c.bootOptions.skipConductor }),
      {
        lifetime: Lifetime.SINGLETON,
        dispose: (s) => s.stop(),
      },
    ),

    arkdLauncher: asFunction(
      (c: { config: ArkConfig; bootOptions: AppBootOptions }) =>
        new ArkdLauncher(c.config, { skip: c.bootOptions.skipConductor }),
      {
        lifetime: Lifetime.SINGLETON,
        dispose: (s) => s.stop(),
      },
    ),

    metricsPoller: asFunction(
      (c: { app: AppContext; bootOptions: AppBootOptions }) =>
        new MetricsPoller(c.app, { skip: c.bootOptions.skipMetrics }),
      {
        lifetime: Lifetime.SINGLETON,
        dispose: (s) => s.stop(),
      },
    ),

    maintenancePollers: asFunction((c: { app: AppContext }) => new MaintenancePollers(c.app), {
      lifetime: Lifetime.SINGLETON,
      dispose: (s) => s.stop(),
    }),

    staleStateDetector: asFunction((c: { app: AppContext }) => new StaleStateDetector(c.app), {
      lifetime: Lifetime.SINGLETON,
      // no-op stop (one-shot scan)
    }),

    signalHandlers: asFunction(
      (c: { app: AppContext; bootOptions: AppBootOptions }) =>
        new SignalHandlers(c.app, { skip: c.bootOptions.skipSignals }),
      {
        lifetime: Lifetime.SINGLETON,
        dispose: (s) => s.stop(),
      },
    ),

    // SessionDrain resolves LAST in START_ORDER -> disposes FIRST on shutdown.
    // Its stop() drains pending dispatches + optionally stops every running
    // session while the conductor/arkd are still up.
    sessionDrain: asFunction(
      (c: { app: AppContext; bootOptions: AppBootOptions }) =>
        new SessionDrain(c.app, { cleanupOnShutdown: c.bootOptions.cleanupOnShutdown }),
      {
        lifetime: Lifetime.SINGLETON,
        dispose: async (s) => {
          await s.stop();
        },
      },
    ),

    // Lifecycle orchestrator -- resolved + invoked by AppContext.boot().
    lifecycle: asFunction((_c: unknown) => new Lifecycle(container), { lifetime: Lifetime.SINGLETON }),
  });
}
