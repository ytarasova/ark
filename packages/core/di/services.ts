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
import type { FlowStateRepository } from "../repositories/flow-state.js";
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
import { executeAction } from "../services/actions/index.js";
import { getOutput } from "../services/session-output.js";
import { removeSessionWorktree } from "../services/worktree/index.js";
import { deletePerSessionCredsSecret, materializeClaudeAuthForDispatch } from "../services/dispatch-claude-auth.js";
import { garbageCollectComputeIfTemplate } from "../services/compute-lifecycle.js";
import { capturePlanMdIfPresent } from "../services/plan-artifact.js";
import { saveCheckpoint } from "../session/checkpoint.js";
import { provisionWorkspaceWorkdir } from "../workspace/provisioner.js";
import * as flow from "../state/flow.js";
import { extractAndSaveSkills } from "../agent/skill-extractor.js";
import { getSessionConversation } from "../search/search.js";
import { logDebug } from "../observability/structured-log.js";
import { buildTaskWithHandoff, extractSubtasks } from "../services/task-builder.js";
import { indexRepoForDispatch, injectKnowledgeContext, injectRepoMap } from "../services/dispatch-context.js";
import * as agentRegistry from "../agent/agent.js";
import { getExecutor } from "../executor.js";
import { startStatusPoller } from "../executors/status-poller.js";
import { fork as forkFn, fanOut as fanOutFn } from "../services/fork-join.js";
import type { ComputeService as ComputeServiceType } from "../services/compute.js";
import type { PluginRegistry } from "../plugins/registry.js";

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

    // DispatchService -- RF-3 narrow deps. No AppContext field. Callbacks
    // wrap the still-AppContext-taking helpers (buildTaskWithHandoff,
    // indexRepoForDispatch, materializeClaudeAuthForDispatch, ...); the
    // class body never sees app. `getApp` exists solely to feed
    // `LaunchOpts.app` into executors (separate migration).
    dispatchService: asFunction(
      (c: {
        sessions: SessionRepository;
        computes: ComputeRepository;
        events: EventRepository;
        flowStates: FlowStateRepository;
        flows: FlowStore;
        runtimes: RuntimeStore;
        computeService: ComputeServiceType;
        pluginRegistry: PluginRegistry;
        statusPollers: StatusPollerRegistry;
        config: ArkConfig;
        app: AppContext;
      }) =>
        new DispatchService({
          sessions: c.sessions,
          computes: c.computes,
          events: c.events,
          flowStates: c.flowStates,
          flows: c.flows,
          runtimes: c.runtimes,
          computeService: c.computeService,
          pluginRegistry: c.pluginRegistry,
          statusPollers: c.statusPollers,
          launcher: c.app.launcher,
          config: c.config,
          secrets: c.app.mode.secrets,

          // Hosted-mode: scheduler may be unset in local profiles. Accessor
          // throws when missing, so wrap in try/catch for the null return.
          getScheduler: () => {
            try {
              return c.app.scheduler;
            } catch {
              return null;
            }
          },

          // Flow + task-building callbacks
          getStage: (flowName, stageName) => flow.getStage(c.app, flowName, stageName),
          getStageAction: (flowName, stageName) => flow.getStageAction(c.app, flowName, stageName),
          buildTask: (session, stage, agentName) => buildTaskWithHandoff(c.app, session, stage, agentName),
          extractSubtasks: (session) => extractSubtasks(c.app, session),
          indexRepo: (session, log) => indexRepoForDispatch(c.app, session, log),
          injectKnowledge: (session, task) => injectKnowledgeContext(c.app, session, task),
          injectRepoMap: (session, task) => injectRepoMap(session, task),
          materializeClaudeAuth: (session, compute) => materializeClaudeAuthForDispatch(c.app, session, compute),
          resolveAgent: (agentName, sessionVars, opts) =>
            agentRegistry.resolveAgentWithRuntime(c.app, agentName, sessionVars, opts),
          buildClaudeArgs: (agent, opts) =>
            agentRegistry.buildClaudeArgs(agent as any, {
              autonomy: opts.autonomy,
              projectRoot: opts.projectRoot,
              app: c.app,
            }),
          resolveExecutor: (runtime) => c.app.pluginRegistry.executor(runtime) ?? getExecutor(runtime),

          // Lifecycle / follow-on
          checkpoint: (sessionId) => {
            void saveCheckpoint({ sessions: c.sessions, events: c.events }, sessionId);
          },
          mediateStageHandoff: (sessionId, opts) => c.app.sessionHooks.mediateStageHandoff(sessionId, opts),
          executeAction: (sessionId, action) => c.app.stageAdvance.executeAction(sessionId, action),
          dispatchChild: (childId) => c.app.dispatchService.dispatch(childId),
          fork: (parentId, task, opts) => forkFn(c.app, parentId, task, opts),
          fanOut: (parentId, spec) => fanOutFn(c.app, parentId, spec),
          startStatusPoller: (sessionId, tmuxName, runtime) => startStatusPoller(c.app, sessionId, tmuxName, runtime),

          // Executor-interface coupling: LaunchOpts.app is required until
          // executors stop touching AppContext (separate migration).
          getApp: () => c.app,
        }),
      { lifetime: Lifetime.SINGLETON },
    ),

    // StageAdvanceService -- RF-3 narrow deps. No AppContext. Callbacks break
    // the StageAdvance <-> SessionLifecycle cycle (clone / runVerification /
    // recordSessionUsage) and keep the class free of back-refs.
    stageAdvance: asFunction(
      (c: {
        sessions: SessionRepository;
        events: EventRepository;
        messages: MessageRepository;
        todos: TodoRepository;
        flowStates: FlowStateRepository;
        flows: FlowStore;
        runtimes: RuntimeStore;
        transcriptParsers: TranscriptParserRegistry;
        usageRecorder: UsageRecorder;
        config: ArkConfig;
        db: DatabaseAdapter;
        app: AppContext;
      }) =>
        new StageAdvanceService({
          sessions: c.sessions,
          events: c.events,
          messages: c.messages,
          todos: c.todos,
          flowStates: c.flowStates,
          flows: c.flows,
          runtimes: c.runtimes,
          transcriptParsers: c.transcriptParsers,
          usageRecorder: c.usageRecorder,
          config: c.config,
          db: c.db,
          dispatch: (id) => c.app.dispatchService.dispatch(id),
          executeAction: (id, action, opts) => executeAction(c.app, id, action, opts),
          runVerification: (id) => c.app.sessionLifecycle.runVerification(id),
          recordSessionUsage: (session, usage, provider, source) =>
            c.app.sessionLifecycle.recordSessionUsage(session, usage, provider, source),
          sessionClone: (id, newName) => c.app.sessionLifecycle.clone(id, newName),
          capturePlanMd: (session) => capturePlanMdIfPresent(c.app, session),
          gcComputeIfTemplate: (computeName) => garbageCollectComputeIfTemplate(c.app, computeName ?? null),
          extractAndSaveSkills: async (sessionId) => {
            try {
              const conv = await getSessionConversation(c.app, sessionId);
              if (conv.length === 0) return;
              const turns = conv.map((cv) => ({
                role: cv.role === "message" ? "user" : "assistant",
                content: cv.content,
              }));
              extractAndSaveSkills(sessionId, turns, c.app);
            } catch {
              logDebug("session", "skill extraction is best-effort");
            }
          },
          saveCheckpoint: (sessionId) => saveCheckpoint({ sessions: c.sessions, events: c.events }, sessionId),
          getStage: (flowName, stageName) => flow.getStage(c.app, flowName, stageName),
          getStageAction: (flowName, stageName) => flow.getStageAction(c.app, flowName, stageName),
          resolveNextStage: (flowName, stage, outcome) => flow.resolveNextStage(c.app, flowName, stage, outcome),
          evaluateGate: (flowName, stage, session) => flow.evaluateGate(c.app, flowName, stage, session),
        }),
      { lifetime: Lifetime.SINGLETON },
    ),
  });
}
