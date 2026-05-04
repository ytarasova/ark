/**
 * Shared types + `DispatchDeps` interface for the dispatch service.
 *
 * DispatchService does NOT hold an AppContext. Every capability it needs is
 * declared here as either a narrow repository/store/service reference OR a
 * callback wrapping a free helper that currently still takes AppContext.
 * Callbacks are wired at the container-registration layer where a single
 * `c.app` reference is acceptable; the dispatch class body never sees
 * AppContext itself. Follows the `SessionHooksDeps` / `SessionLifecycle`
 * idiom.
 */

import type { SessionRepository } from "../../repositories/session.js";
import type { ComputeRepository } from "../../repositories/compute.js";
import type { EventRepository } from "../../repositories/event.js";
import type { FlowStateRepository } from "../../repositories/flow-state.js";
import type { FlowStore } from "../../stores/flow-store.js";
import type { RuntimeStore } from "../../stores/runtime-store.js";
import type { ModelService } from "../../models/ModelService.js";
import type { ComputeService } from "../compute.js";
import type { PluginRegistry } from "../../plugins/registry.js";
import type { StatusPollerRegistry } from "../../executors/status-poller.js";
import type { ArkConfig } from "../../config.js";
import type { SecretsCapability } from "../../secrets/types.js";
import type { Session, Compute } from "../../../types/index.js";
import type { SessionScheduler } from "../../hosted/scheduler.js";
import type { StageDefinition, StageAction } from "../../state/flow.js";
import type { ClaudeAuthMaterialization } from "../dispatch-claude-auth.js";

// ── Callbacks wrapping free-functions that still take AppContext ────────────

/** Stage lookup from the flow registry. */
export interface GetStageCb {
  (flowName: string, stageName: string): StageDefinition | null;
}

/** Stage action (agent | action | fork | for_each) lookup. */
export interface GetStageActionCb {
  (flowName: string, stageName: string): StageAction;
}

/** Build the full task prompt with per-stage handoff context. */
export interface BuildTaskCb {
  (session: Session, stage: string, agentName: string): Promise<string>;
}

/** Extract per-subtask bundles for fork / fan-out splits. */
export interface ExtractSubtasksCb {
  (session: Session): Promise<{ name: string; task: string }[]>;
}

/** Index the session repo into the knowledge graph (best-effort, may noop). */
export interface IndexRepoCb {
  (session: Session, log: (msg: string) => void): Promise<void>;
}

/** Prepend knowledge-graph context above the agent's task text. */
export interface InjectKnowledgeCb {
  (session: Session, task: string): Promise<string>;
}

/** Prepend an ASCII repo map above the agent's task text. */
export interface InjectRepoMapCb {
  (session: Session, task: string): string;
}

/** Materialize tenant-level claude auth into launch env + optional k8s Secret. */
export interface MaterializeClaudeAuthCb {
  (session: Session, compute: Compute | null): Promise<ClaudeAuthMaterialization>;
}

/** Resolve an agent definition by name with optional runtime override. */
export interface ResolveAgentCb {
  (
    agentName: string,
    sessionVars: Record<string, unknown>,
    opts: { runtimeOverride?: string; projectRoot?: string },
  ): { name: string; model: string; [k: string]: any } | null;
}

/** Build executor-specific CLI args (currently only claude-code). */
export interface BuildClaudeArgsCb {
  (
    agent: { name: string; model: string; [k: string]: unknown },
    opts: { autonomy: string; projectRoot?: string },
  ): string[];
}

/** Save a session checkpoint (best-effort). */
export interface CheckpointCb {
  (sessionId: string): void;
}

/** Mediate the stage handoff after an in-process action stage completes. */
export interface MediateStageHandoffCb {
  (sessionId: string, opts?: { autoDispatch?: boolean; source?: string; outcome?: string }): Promise<unknown>;
}

/** Execute an `action:` stage (dispatched in-process, no agent launch). */
export interface ExecuteActionCb {
  (sessionId: string, action: string): Promise<{ ok: boolean; message: string }>;
}

/** Nested dispatch call used by fork/fan-out for child sessions. */
export interface DispatchChildCb {
  (sessionId: string): Promise<DispatchResult>;
}

/** Fork primitive from fork-join.ts (dynamic imported today). */
export interface ForkCb {
  (
    parentId: string,
    task: string,
    opts: { dispatch: boolean },
  ): Promise<{ ok: true; sessionId: string } | { ok: false; message: string }>;
}

/** Start the per-session status poller (crash-detection fallback). */
export interface StartStatusPollerCb {
  (sessionId: string, tmuxName: string, runtime: string): void;
}

/**
 * Executor registry lookup. The old flat module used
 * `app.pluginRegistry.executor(name) ?? getExecutor(name)`; pre-bound here so
 * the class body doesn't dual-read. A returning executor's `launch()` still
 * accepts an optional `app` parameter (executor interface constraint we do
 * not break in this migration) -- supplied via `getApp` below.
 */
export interface ResolveExecutorCb {
  (runtime: string): import("../../executor.js").Executor | undefined;
}

/**
 * Last-resort AppContext accessor -- used ONLY to satisfy the executor
 * interface (`LaunchOpts.app?`) which reads `app.sessions`, `app.config`,
 * `app.computes`. Refactoring every executor is out of scope for this PR;
 * this callback keeps that coupling localized to a single call site inside
 * dispatch-core so the rest of the class never touches AppContext.
 */
export interface GetAppCb {
  (): import("../../app.js").AppContext;
}

// ── Deps ────────────────────────────────────────────────────────────────────

/**
 * Every field is read by at least one method on DispatchService (or its
 * private sub-classes). Justifications:
 *
 *   sessions          -- get/update/mergeConfig for the session row
 *   computes          -- get/stash per-session compute row + template lookup
 *   events            -- audit-log stage_started, dispatch, rework, etc.
 *   flowStates        -- setCurrentStage after successful launch
 *   flows             -- currently only read indirectly via getStage callbacks
 *   runtimes          -- runtime.secrets lookup for stage secrets merge
 *   computeService    -- create cloned template rows (per-session concrete)
 *   pluginRegistry    -- executor lookup (wrapped by resolveExecutor callback)
 *   statusPollers     -- currently unused at top level (poller callback wraps it)
 *   launcher          -- kill tmux on mid-dispatch race abort
 *   config            -- arkDir, authSection.defaultTenant, computeTemplates
 *   secrets           -- resolveMany(tenant, names) for stage+runtime secret merge
 *   getScheduler      -- hosted mode only; returns null in local mode
 *   getStage/Action   -- stage definition + action-type lookup
 *   buildTask         -- buildTaskWithHandoff helper (still takes AppContext)
 *   extractSubtasks   -- extractSubtasks helper (for fork)
 *   indexRepo         -- indexRepoForDispatch helper
 *   injectKnowledge   -- injectKnowledgeContext helper
 *   injectRepoMap     -- injectRepoMap helper
 *   materializeClaudeAuth -- tenant auth materialization
 *   resolveAgent      -- agentRegistry.resolveAgentWithRuntime
 *   buildClaudeArgs   -- agentRegistry.buildClaudeArgs (claude-code only)
 *   resolveExecutor   -- pluginRegistry + legacy registry fallback lookup
 *   checkpoint        -- saveCheckpoint (session/checkpoint.ts, best-effort)
 *   mediateStageHandoff -- follow-on handoff after action-stage completes
 *   executeAction     -- action-stage in-process executor
 *   dispatchChild     -- nested dispatch() for fan-out children
 *   fork              -- fork primitive (dynamic-imported today)
 *   startStatusPoller -- best-effort crash-detection poller
 *   getApp            -- ONLY for LaunchOpts.app executor-interface coupling
 */
export interface DispatchDeps {
  // Narrow repos + stores
  sessions: SessionRepository;
  computes: ComputeRepository;
  events: EventRepository;
  flowStates: FlowStateRepository;
  flows: FlowStore;
  runtimes: RuntimeStore;
  /**
   * Domain service over the model catalog. When present, dispatch-core
   * resolves agent.model -> provider slug via `models.resolveSlug()`.
   * Absent in tests that don't exercise the catalog path; raw `agent.model`
   * flows through in that case.
   */
  models?: ModelService;
  computeService: ComputeService;
  pluginRegistry: PluginRegistry;
  statusPollers: StatusPollerRegistry;
  config: ArkConfig;
  secrets: SecretsCapability;

  // Hosted-mode optional
  getScheduler: () => SessionScheduler | null;

  // Flow + task-building callbacks
  getStage: GetStageCb;
  getStageAction: GetStageActionCb;
  buildTask: BuildTaskCb;
  extractSubtasks: ExtractSubtasksCb;
  indexRepo: IndexRepoCb;
  injectKnowledge: InjectKnowledgeCb;
  injectRepoMap: InjectRepoMapCb;
  materializeClaudeAuth: MaterializeClaudeAuthCb;
  resolveAgent: ResolveAgentCb;
  buildClaudeArgs: BuildClaudeArgsCb;
  resolveExecutor: ResolveExecutorCb;

  // Lifecycle / follow-on
  checkpoint: CheckpointCb;
  mediateStageHandoff: MediateStageHandoffCb;
  executeAction: ExecuteActionCb;
  dispatchChild: DispatchChildCb;
  fork: ForkCb;
  startStatusPoller: StartStatusPollerCb;

  // Executor-interface coupling only.
  getApp: GetAppCb;
}

/**
 * Contract for dispatch return values.
 *
 *   ok:true, launched:true   -- session transitioned to running; an agent
 *                               process is alive and session_id is set.
 *
 *   ok:true, launched:false  -- dispatch completed intentionally WITHOUT
 *                               launching an agent (action stage,
 *                               fork-parent, for_each parent, already-
 *                               running noop, hosted-mode handoff, empty
 *                               for_each list). `reason` names the case.
 *
 *   ok:false                 -- dispatch failed; caller marks the session
 *                               failed. No `launched` field -- the failure
 *                               is unambiguous.
 */
export type DispatchResult =
  | { ok: true; launched: true; message: string }
  | { ok: true; launched: false; reason: string; message: string }
  | { ok: false; message: string };
