/**
 * DI registrations for application services.
 *
 * Services are singleton-scoped (one instance per container). They receive
 * dependencies via constructor arguments resolved from the container's
 * cradle. Factories use `asFunction` with explicit cradle reads so
 * registrations survive `bun build --compile` minification.
 */

import { asFunction, Lifetime } from "awilix";
import type { AppContainer } from "../container.js";
import type { DatabaseAdapter } from "../database/index.js";
import type { AppContext } from "../app.js";
import type { ArkConfig } from "../config.js";
import type { SessionRepository } from "../repositories/session.js";
import type { ComputeRepository } from "../repositories/compute.js";
import type { EventRepository } from "../repositories/event.js";
import type { MessageRepository } from "../repositories/message.js";
import type { TodoRepository } from "../repositories/todo.js";
import type { FlowStore } from "../stores/flow-store.js";
import type { RuntimeStore } from "../stores/runtime-store.js";
import type { UsageRecorder } from "../observability/usage.js";
import type { TranscriptParserRegistry } from "../runtimes/transcript-parser.js";
import type { StatusPollerRegistry } from "../executors/status-poller.js";
import { SessionService, ComputeService, HistoryService } from "../services/index.js";
import { SessionHooks } from "../services/session-hooks/index.js";
import { SessionLifecycle } from "../services/session/index.js";
import { DispatchService } from "../services/dispatch/index.js";
import { StageAdvanceService } from "../services/stage-advance/index.js";
import { getOutput } from "../services/session-output.js";
import { removeSessionWorktree } from "../services/worktree/index.js";
import { deletePerSessionCredsSecret } from "../services/dispatch-claude-auth.js";
import { garbageCollectComputeIfTemplate } from "../services/compute-lifecycle.js";
import { provisionWorkspaceWorkdir } from "../workspace/provisioner.js";
import * as flow from "../state/flow.js";

/**
 * Register the core services.
 *
 * Every registration is a singleton. `app: AppContext` is registered in
 * `AppContext.constructor()` so `c.app` is always resolvable by the time
 * these factories run.
 */
export function registerServices(container: AppContainer): void {
  container.register({
    sessionService: asFunction(
      (c: { sessions: SessionRepository; events: EventRepository; messages: MessageRepository; app: AppContext }) =>
        new SessionService(c.sessions, c.events, c.messages, c.app),
      { lifetime: Lifetime.SINGLETON },
    ),

    computeService: asFunction(
      (c: { computes: ComputeRepository; app: AppContext }) => new ComputeService(c.computes, c.app),
      { lifetime: Lifetime.SINGLETON },
    ),

    historyService: asFunction((c: { db: DatabaseAdapter }) => new HistoryService(c.db), {
      lifetime: Lifetime.SINGLETON,
    }),

    sessionHooks: asFunction(
      (c: {
        sessions: SessionRepository;
        events: EventRepository;
        messages: MessageRepository;
        todos: TodoRepository;
        flows: FlowStore;
        usageRecorder: UsageRecorder;
        transcriptParsers: TranscriptParserRegistry;
        app: AppContext;
      }) =>
        new SessionHooks({
          sessions: c.sessions,
          events: c.events,
          messages: c.messages,
          todos: c.todos,
          flows: c.flows,
          usageRecorder: c.usageRecorder,
          transcriptParsers: c.transcriptParsers,
          advance: (id, force, outcome) => c.app.stageAdvance.advance(id, force, outcome),
          dispatch: async (id) => {
            await c.app.dispatchService.dispatch(id);
          },
          executeAction: (id, action) => c.app.stageAdvance.executeAction(id, action),
          runVerification: (id) => c.app.sessionLifecycle.runVerification(id),
          recordSessionUsage: (session, usage, provider, source) =>
            c.app.sessionLifecycle.recordSessionUsage(session, usage, provider, source),
          getOutput: (id, opts) => getOutput(c.app, id, opts),
          getStage: (flowName, stageName) => flow.getStage(c.app, flowName, stageName),
          getStageAction: (flowName, stageName) => flow.getStageAction(c.app, flowName, stageName),
        }),
      { lifetime: Lifetime.SINGLETON },
    ),

    sessionLifecycle: asFunction(
      (c: {
        sessions: SessionRepository;
        events: EventRepository;
        messages: MessageRepository;
        todos: TodoRepository;
        computes: ComputeRepository;
        flows: FlowStore;
        runtimes: RuntimeStore;
        usageRecorder: UsageRecorder;
        statusPollers: StatusPollerRegistry;
        config: ArkConfig;
        app: AppContext;
      }) =>
        new SessionLifecycle({
          sessions: c.sessions,
          events: c.events,
          messages: c.messages,
          todos: c.todos,
          computes: c.computes,
          flows: c.flows,
          runtimes: c.runtimes,
          getCodeIntel: () => c.app.codeIntel,
          config: c.config,
          usageRecorder: c.usageRecorder,
          getLauncher: () => c.app.launcher,
          statusPollers: c.statusPollers,
          dispatch: (id) => c.app.dispatchService.dispatch(id),
          removeWorktree: (session) => removeSessionWorktree(c.app, session),
          deleteCredsSecret: (session, compute) => deletePerSessionCredsSecret(c.app, session, compute),
          gcComputeIfTemplate: (computeName) => garbageCollectComputeIfTemplate(c.app, computeName ?? null),
          resolveProvider: (session) => c.app.resolveProvider(session),
          resolveComputeTarget: (session) => c.app.resolveComputeTarget(session),
          advance: (id, force) => c.app.stageAdvance.advance(id, force),
          provisionWorkspaceWorkdir: (session, ws, opts) => provisionWorkspaceWorkdir(c.app, session, ws as any, opts),
        }),
      { lifetime: Lifetime.SINGLETON },
    ),

    // DispatchService + StageAdvanceService are thin class wrappers over the
    // legacy `dispatch()` / `advance()` free functions. They exist so callers
    // can write `app.dispatchService.dispatch(id)` while the bigger
    // class-based refactor lands. Each holds a single AppContext handle.
    dispatchService: asFunction((c: { app: AppContext }) => new DispatchService(c.app), {
      lifetime: Lifetime.SINGLETON,
    }),

    stageAdvance: asFunction((c: { app: AppContext }) => new StageAdvanceService(c.app), {
      lifetime: Lifetime.SINGLETON,
    }),
  });
}
