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
import type { SessionRepository } from "../repositories/session.js";
import type { ComputeRepository } from "../repositories/compute.js";
import type { EventRepository } from "../repositories/event.js";
import type { MessageRepository } from "../repositories/message.js";
import type { TodoRepository } from "../repositories/todo.js";
import type { FlowStore } from "../stores/flow-store.js";
import type { UsageRecorder } from "../observability/usage.js";
import type { TranscriptParserRegistry } from "../runtimes/transcript-parser.js";
import { SessionService, ComputeService, HistoryService } from "../services/index.js";
import { SessionHooks } from "../services/session-hooks/index.js";
import { advance } from "../services/stage-advance.js";
import { dispatch } from "../services/dispatch.js";
import { recordSessionUsage, runVerification } from "../services/session-lifecycle.js";
import { getOutput } from "../services/session-output.js";
import { executeAction } from "../services/actions/index.js";
import * as flow from "../state/flow.js";

/**
 * Register the three core services.
 *
 * SessionService is the only one that depends on AppContext (for legacy
 * session-orchestration delegation). The AppContext is registered in the
 * container before services so `app` resolves successfully.
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

    // SessionHooks composes three appliers (hook-status, report, handoff)
    // over a narrow Deps slice. Callbacks wrap still-AppContext-taking
    // helpers (advance/dispatch/runVerification/...); they'll be replaced
    // with typed class methods as those migrations land.
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
          advance: (id, force, outcome) => advance(c.app, id, force, outcome),
          dispatch: async (id) => {
            await dispatch(c.app, id);
          },
          executeAction: (id, action) => executeAction(c.app, id, action),
          runVerification: (id) => runVerification(c.app, id),
          recordSessionUsage: (session, usage, provider, source) =>
            recordSessionUsage(c.app, session, usage, provider, source),
          getOutput: (id, opts) => getOutput(c.app, id, opts),
          getStage: (flowName, stageName) => flow.getStage(c.app, flowName, stageName),
          getStageAction: (flowName, stageName) => flow.getStageAction(c.app, flowName, stageName),
        }),
      { lifetime: Lifetime.SINGLETON },
    ),
  });
}
