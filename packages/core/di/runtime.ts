/**
 * DI registrations for runtime-adjacent singletons:
 *   - Pricing registry (model cost table)
 *   - Usage recorder (token accounting, depends on pricing)
 *   - Transcript parser registry (polymorphic, one per agent tool)
 *   - Plugin registry (executors + pluggable compute providers)
 *   - Snapshot store (FS-backed by default, swappable for hosted deployments)
 *
 * Pools / router / conductor live outside the container today because
 * their lifecycles are managed directly by `AppContext.boot`. Migrating
 * those is a follow-up PR -- see TODO comments in app.ts.
 */

import { asFunction, Lifetime } from "awilix";
import { join } from "path";
import type { AppContainer } from "../container.js";
import type { IDatabase } from "../database/index.js";
import type { ArkConfig } from "../config.js";
import { PricingRegistry } from "../observability/pricing.js";
import { UsageRecorder } from "../observability/usage.js";
import { TranscriptParserRegistry } from "../runtimes/transcript-parser.js";
import { ClaudeTranscriptParser } from "../runtimes/claude/parser.js";
import { CodexTranscriptParser } from "../runtimes/codex/parser.js";
import { GeminiTranscriptParser } from "../runtimes/gemini/parser.js";
import { createPluginRegistry } from "../plugins/registry.js";
import { FsSnapshotStore } from "../../compute/core/snapshot-store-fs.js";
import type { SessionRepository } from "../repositories/session.js";

/**
 * Register runtime singletons: pricing, usage recorder, transcript parsers,
 * plugin registry, snapshot store.
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

    usageRecorder: asFunction((c: { db: IDatabase; pricing: PricingRegistry }) => new UsageRecorder(c.db, c.pricing), {
      lifetime: Lifetime.SINGLETON,
    }),

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

    snapshotStore: asFunction((c: { config: ArkConfig }) => new FsSnapshotStore(join(c.config.arkDir, "snapshots")), {
      lifetime: Lifetime.SINGLETON,
    }),
  });
}
