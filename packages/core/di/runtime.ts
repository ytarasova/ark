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
import type { DatabaseAdapter } from "../database/index.js";
import type { ArkConfig } from "../config.js";
import type { AppContext } from "../app.js";
import type { PluginRegistry } from "../plugins/registry.js";
import type { UsageRecorder } from "../observability/usage.js";
import type { TensorZeroLauncher as TensorZeroLauncherType } from "../infra/tensorzero-launcher.js";
import { PricingRegistry } from "../observability/pricing.js";
import { logWarn } from "../observability/structured-log.js";
import { UsageRecorder as UsageRecorderCtor } from "../observability/usage.js";
import { TranscriptParserRegistry } from "../runtimes/transcript-parser.js";
import { ClaudeTranscriptParser } from "../runtimes/claude/parser.js";
import { CodexTranscriptParser } from "../runtimes/codex/parser.js";
import { GeminiTranscriptParser } from "../runtimes/gemini/parser.js";
import { AgentSdkParser } from "../runtimes/claude-agent/parser.js";
import { createPluginRegistry } from "../plugins/registry.js";
import { FsSnapshotStore } from "../compute/snapshot-store-fs.js";
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
import { BootCleanup } from "../infra/boot-cleanup.js";
import { SessionDrain } from "../infra/session-drain.js";
import { StatusPollerRegistry } from "../executors/status-poller.js";
import { TicketProviderRegistry } from "../tickets/registry.js";
import { McpPool, registerMcpPool } from "../mcp-pool.js";

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
        reg.refreshFromRemote().catch((err) => {
          logWarn("general", `pricing: remote refresh failed, using bundled defaults`, {
            error: err instanceof Error ? err.message : String(err),
          });
        });
        return reg;
      },
      { lifetime: Lifetime.SINGLETON },
    ),

    usageRecorder: asFunction(
      (c: { db: DatabaseAdapter; pricing: PricingRegistry }) => new UsageRecorderCtor(c.db, c.pricing),
      {
        lifetime: Lifetime.SINGLETON,
      },
    ),

    transcriptParsers: asFunction(
      (_c: { sessions: SessionRepository; config: ArkConfig }) => {
        const registry = new TranscriptParserRegistry();
        // PR 3 of the async-DB refactor (option b from the hand-off):
        //
        // Claude parser uses session.claude_session_id (set at launch via
        // --session-id) to construct the exact transcript path. The
        // sessionIdLookup callback was previously a synchronous workdir ->
        // claude_session_id lookup against the session repo; once repos went
        // async we cannot do that lookup from inside this sync callback.
        //
        // Trade-off table:
        //   (a) Make the callback async and propagate `Promise<string | null>`
        //       through ClaudeTranscriptParser.findForSession. Touches every
        //       parser implementation + every caller (status-poller, hooks,
        //       stage-advance) and gains nothing operationally -- the
        //       transcript discovery can already cope by scanning the workdir.
        //   (b) Pre-resolve workdir -> claude_session_id at executor launch
        //       time and pass it through opts. The CallSite already has the
        //       AppContext when calling parser.findForSession, so we just plumb
        //       a `claudeSessionId` hint instead of a callback.
        //   (c) Drop the lookup entirely and rely on the parser's filesystem
        //       scan (timestamp-bracketed glob within workdir).
        //
        // We're going with (b) operationally + (c) as the safety net: the
        // callback returns null so the parser falls back to scanning the
        // workdir, and callers that need exact targeting pass
        // `claudeSessionId` directly via parser.parse(transcriptPath) (which
        // they already do for hook-driven usage tracking in session-hooks.ts).
        //
        // Returning null here is the documented, intentional fallback path,
        // not a TODO. See packages/core/runtimes/claude/parser.ts for how
        // findForSession degrades when the callback yields nothing.
        registry.register(new ClaudeTranscriptParser(undefined, (_workdir) => null));
        registry.register(new CodexTranscriptParser());
        registry.register(new GeminiTranscriptParser());
        registry.register(new AgentSdkParser(_c.config.dirs.tracks));
        return registry;
      },
      { lifetime: Lifetime.SINGLETON },
    ),

    pluginRegistry: asFunction(() => createPluginRegistry(), { lifetime: Lifetime.SINGLETON }),

    statusPollers: asFunction(() => new StatusPollerRegistry(), {
      lifetime: Lifetime.SINGLETON,
      dispose: (r: StatusPollerRegistry) => r.dispose(),
    }),

    // Snapshot store. Local mode uses the FS-backed store at
    // `<arkDir>/snapshots/`. Hosted mode refuses the FS fallback at boot --
    // snapshots are pod-ephemeral and not visible across replicas, so any
    // session pause/resume that lands on a different pod would silently fail.
    // Hand-tuned to throw with a clear configuration error so the operator
    // wires up an `S3SnapshotStore` (TODO #fixme) before turning hosted mode
    // on. The interface stays unchanged so the eventual S3 implementation
    // drops in here without rippling through callers.
    snapshotStore: asFunction(
      (c: { config: ArkConfig; mode: import("../modes/app-mode.js").AppMode }) => {
        // ARK_DEV_ALLOW_LOCAL_HOSTED_STORAGE keeps the laptop dev loop
        // usable while an S3SnapshotStore is still TODO. NEVER set in
        // production -- a multi-replica deployment loses snapshot
        // visibility across pods if this is on.
        if (c.mode.kind === "hosted" && process.env.ARK_DEV_ALLOW_LOCAL_HOSTED_STORAGE !== "1") {
          throw new Error(
            "snapshotStore: hosted mode requires a non-fs snapshot backend " +
              "(FsSnapshotStore is pod-ephemeral and not multi-replica safe). " +
              "Wire up an S3SnapshotStore implementation before enabling hosted mode. " +
              "For laptop dev, set ARK_DEV_ALLOW_LOCAL_HOSTED_STORAGE=1 (NOT for prod).",
          );
        }
        return new FsSnapshotStore(join(c.config.dirs.ark, "snapshots"));
      },
      {
        lifetime: Lifetime.SINGLETON,
      },
    ),

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

    bootCleanup: asFunction((c: { app: AppContext }) => new BootCleanup(c.app), {
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

    // Ticket provider registry -- tenant-scoped Jira/GitHub/Linear bindings.
    // Replaces the deleted module-level `_singleton` inside tickets/registry.ts.
    ticketProviderRegistry: asFunction(() => new TicketProviderRegistry(), {
      lifetime: Lifetime.SINGLETON,
    }),

    // MCP socket pool -- shares MCP server processes across sessions. Disposed
    // via container.dispose() so every pooled child exits cleanly on shutdown.
    // The socket directory is resolved from `config.dirs.ark` so concurrent
    // ark processes don't collide on a shared /tmp path.
    mcpPool: asFunction(
      (c: { config: ArkConfig }) => {
        const socketDir = join(c.config.dirs.ark, "mcp-sockets");
        const pool = new McpPool(socketDir);
        // Keep the back-compat `getMcpPool(socketDir)` cache in sync so older
        // call sites share the container-managed instance.
        registerMcpPool(socketDir, pool);
        return pool;
      },
      {
        lifetime: Lifetime.SINGLETON,
        dispose: (pool: McpPool) => pool.stopAll(),
      },
    ),

    // Lifecycle orchestrator -- resolved + invoked by AppContext.boot().
    lifecycle: asFunction((_c: unknown) => new Lifecycle(container), { lifetime: Lifetime.SINGLETON }),
  });
}
