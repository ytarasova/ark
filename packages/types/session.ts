export type SessionStatus =
  | "pending"
  | "ready"
  | "running"
  | "waiting"
  | "stopped"
  | "blocked"
  | "completed"
  | "failed"
  | "deleting"
  | "archived";

/** User-facing session statuses (excludes internal 'deleting'). */
export const SESSION_STATUSES: readonly SessionStatus[] = [
  "pending",
  "ready",
  "running",
  "waiting",
  "stopped",
  "blocked",
  "completed",
  "failed",
  "archived",
] as const;

export interface SessionConfig {
  // Runtime
  turns?: number;
  completion_summary?: string;
  filesChanged?: string[];
  commits?: string[];
  github_url?: string;
  ports?: Array<{ port: number; name?: string; source?: string }>;
  // Compute/infra
  remoteWorkdir?: string;
  worktree?: string | boolean;
  /** Git URL to clone on compute target (no local repo needed) */
  remoteRepo?: string;
  /**
   * Local port the conductor's SSM forward-tunnel for this session is bound
   * to. Set by `EC2Compute.setupTransport` after the tunnel comes up. The
   * conductor's arkd client reads this in preference to `compute.config.
   * arkd_local_forward_port` so concurrent sessions on the same compute
   * don't stomp each other's port. See #423.
   */
  arkd_local_forward_port?: number;
  // Lifecycle
  /**
   * Last stage for which the agent explicitly called the
   * `mcp__ark-stage-control__complete_stage` tool. Set by the hook-status
   * handler when it observes the corresponding `PreToolUse` event. The
   * SessionEnd commit-verifier consults this to distinguish "agent
   * deliberately ended the stage with nothing to commit" (legitimate --
   * e.g. after a user steer asking for a no-op reply) from "agent drifted
   * off-task and exited" (the failure case the verifier was designed for).
   *
   * Without this signal the verifier conflates the two and incorrectly
   * fails sessions where the agent's complete_stage call was the right
   * outcome but no files needed editing.
   */
  stage_complete_signaled?: {
    stage: string;
    reason?: string;
    /** ISO8601 timestamp of the agent's tool call. */
    ts: string;
  };
  _pre_delete_status?: string;
  _deleted_at?: string;
  _pending_handoff?: { agent: string; instructions?: string };
  // Skills attached to session
  skills?: string[];
  // Process tree tracking (set at dispatch, updated by status poller)
  /** PID of the root process in the agent's tmux pane (set at dispatch). */
  launch_pid?: number;
  /** Name of the executor that launched the agent (e.g. "claude-code", "goose"). */
  launch_executor?: string;
  /** ISO timestamp when the agent process was launched. */
  launched_at?: string;
  /** Latest process tree snapshot (updated every ~15s by status poller). */
  process_tree?: {
    rootPid: number;
    children: Array<{ pid: number; ppid: number; command: string; cpu?: number; mem?: number }>;
    capturedAt: string;
  };
  // Extensible for provider-specific state
  [key: string]: unknown;
}

export interface Session {
  id: string;
  ticket: string | null;
  summary: string | null;
  repo: string | null;
  branch: string | null;
  compute_name: string | null;
  session_id: string | null;
  claude_session_id: string | null;
  stage: string | null;
  status: SessionStatus;
  flow: string;
  agent: string | null;
  workdir: string | null;
  pr_url: string | null;
  pr_id: string | null;
  error: string | null;
  parent_id: string | null;
  fork_group: string | null;
  group_name: string | null;
  breakpoint_reason: string | null;
  attached_by: string | null;
  /** Count of review-gate rejections (rework cycles) against this session. */
  rejection_count: number;
  /**
   * Rendered rework prompt, set by `gate/reject`. Appended to the next dispatch
   * of the current stage, then cleared. Null when no rework is pending.
   */
  rework_prompt: string | null;
  /** ISO8601 timestamp of the most recent rejection. Null when never rejected. */
  rejected_at: string | null;
  /** Last rejection reason supplied by the reviewer. Null when never rejected. */
  rejected_reason: string | null;
  /**
   * Initial PTY column count (tmux geometry at dispatch). Persisted so the
   * terminal replay renders at the original width even if the browser is
   * narrower. Null for legacy rows. See bug 4 in session-dispatch cascade.
   */
  pty_cols: number | null;
  /** Initial PTY row count (tmux geometry at dispatch). Null for legacy rows. */
  pty_rows: number | null;
  config: SessionConfig;
  /** User who created this session (multi-user mode). */
  user_id: string | null;
  /** Tenant scope (multi-tenant mode). Defaults to "default" in single-tenant deployments. */
  tenant_id: string;
  /**
   * Workspace this session runs against. Nullable for back-compat; Wave 2b
   * will start treating this as the primary dispatch unit (multi-repo
   * worktree). Wave 2a only threads the column through repo + CLI.
   */
  workspace_id: string | null;
  /**
   * Orchestrator that drives this session's state machine. `"custom"` is the
   * in-tree engine under `packages/core/services/flow.ts`. `"temporal"` routes
   * through a Temporal workflow (see packages/core/temporal/).
   */
  orchestrator: SessionOrchestrator;
  /**
   * Temporal workflow ID for sessions managed by the Temporal orchestrator.
   * Format: `session-<sessionId>`. Null for sessions using the custom engine.
   */
  workflow_id: string | null;
  created_at: string;
  updated_at: string;
}

/** Enum of supported orchestrators. `custom` is the in-tree engine; `temporal` routes through a Temporal workflow. */
export type SessionOrchestrator = "custom" | "temporal";

export interface SessionInputs {
  /** Role-keyed absolute paths to files the session should consume. */
  files?: Record<string, string>;
  /** Arbitrary k=v params. Flattened into `{inputs.params.<key>}` templating. */
  params?: Record<string, string>;
}

/**
 * Inline flow/agent/runtime/model shapes accepted at dispatch time. These are
 * deliberately loose -- the domain validation lives in `resolveStage()`. Types
 * are declared here so CLI + server + CLI tests share one definition.
 */
export interface InlineModelInput {
  id: string;
  display?: string;
  provider: string;
  aliases?: string[];
  provider_slugs: Record<string, string>;
  context_window?: number;
  pricing?: Record<string, unknown>;
  capabilities?: string[];
}

export interface InlineRuntimeInput {
  name: string;
  description?: string;
  type: string;
  command?: string[];
  task_delivery?: "stdin" | "file" | "arg";
  permission_mode?: string;
  env?: Record<string, string>;
  mcp_servers?: (string | Record<string, unknown>)[];
  secrets?: string[];
  billing?: Record<string, unknown>;
  task_prompt?: string;
  compat?: string[];
}

export interface InlineAgentInput {
  name?: string;
  description?: string;
  runtime: string | InlineRuntimeInput;
  model?: string | InlineModelInput;
  max_turns?: number;
  system_prompt: string;
  tools?: string[];
  mcp_servers?: (string | Record<string, unknown>)[];
  skills?: string[];
  memories?: string[];
  context?: string[];
  permission_mode?: string;
  env?: Record<string, string>;
  command?: string[];
  task_delivery?: "stdin" | "file" | "arg";
}

export interface InlineStageInput {
  name: string;
  type?: "agent" | "action" | "fork";
  agent?: string | InlineAgentInput;
  action?: string;
  task?: string;
  gate?: "auto" | "manual" | "condition" | "review";
  model?: string;
  depends_on?: string[];
  [k: string]: unknown;
}

export interface InlineFlowInput {
  name?: string;
  description?: string;
  stages: InlineStageInput[];
  [k: string]: unknown;
}

export interface CreateSessionOpts {
  ticket?: string;
  summary?: string;
  repo?: string;
  /**
   * Deterministic git branch name for the session's worktree. When set,
   * setupWorktree cuts (or reuses) this exact branch instead of the default
   * derived name (`feat/<ticket>-<summary>` or `ark-<sessionId>`). Used by
   * for_each + spawn callers that need the same branch across all child
   * iterations targeting the same repo.
   */
  branch?: string;
  /**
   * Cumulative USD cost cap for this session. When set, for_each dispatchers
   * check the sum of prior iteration costs before each iteration and halt with
   * "budget exceeded" if the cap is reached. Stored in session.config.max_budget_usd
   * (no migration needed -- uses the existing JSON config blob).
   */
  max_budget_usd?: number;
  /**
   * Flow reference. Either a name (resolved via FlowStore) or a literal
   * inline flow object. Inline flows are registered on the ephemeral overlay
   * under `inline-<sessionId>` and persisted under `session.config.inline_flow`
   * so the daemon can rehydrate them after a restart.
   */
  flow?: string | InlineFlowInput;
  /**
   * Agent override. Either an agent name or a literal inline agent object
   * (see `InlineAgentInput` for the required fields). Persisted on the
   * session row as a name only; inline agents flow through stage.agent.
   */
  agent?: string | InlineAgentInput | null;
  compute_name?: string;
  workdir?: string;
  group_name?: string;
  config?: Partial<SessionConfig>;
  user_id?: string;
  /** Workspace id for workspace-scoped dispatch. Null/undefined = legacy repo-only. */
  workspace_id?: string | null;
  inputs?: SessionInputs;
  /**
   * Input file attachments. Callers MUST upload bytes to BlobStore first and
   * pass a `locator` here -- inline `content` without a `locator` is rejected
   * at the service boundary (RF-5) so Temporal can serialize activity inputs.
   */
  attachments?: Array<{ name: string; content?: string; type: string; locator?: string }>;
  /**
   * Orchestrator override. Defaults to `"custom"` (in-tree engine). Pass
   * `"temporal"` when creating a session that will be driven by Temporal.
   * Injected by `SessionService.start()` when `features.temporalOrchestration`
   * is enabled -- callers outside the service layer should leave this unset.
   */
  orchestrator?: SessionOrchestrator;
}

export interface SessionListFilters {
  status?: SessionStatus;
  repo?: string;
  group_name?: string;
  groupPrefix?: string;
  parent_id?: string;
  flow?: string;
  limit?: number;
  offset?: number;
  /**
   * When true, restricts results to sessions with `parent_id IS NULL` (roots).
   * Each returned session also carries a `child_stats` rollup summarising its
   * direct descendants. Used by the web UI tree view.
   */
  rootsOnly?: boolean;
}

/**
 * Aggregate rollup over a session's direct children. Emitted alongside parent
 * rows returned by the tree-aware list endpoints (`rootsOnly`, list_children,
 * tree). Null when the session has no children.
 */
export interface SessionChildStats {
  total: number;
  running: number;
  completed: number;
  failed: number;
  cost_usd_sum: number;
}

/**
 * Compact per-iteration projection of a for_each parent's children, ordered
 * by `config.for_each_index` (ascending). Emitted alongside `child_stats`
 * on parent rows so the UI can render real per-iteration progress segments
 * without a second round-trip. Trimmed shape -- just enough for the UI's
 * `buildFlowProgress` to map status -> segment state and key by id. Empty
 * array when the parent has no children.
 */
export interface SessionChildIteration {
  id: string;
  status: string;
  /** Iteration index from `session.config.for_each_index`. May be null for
   *  legacy sessions or non-for_each spawns; UI then orders by created_at. */
  for_each_index: number | null;
  created_at: string | null;
}

/** Session row with attached `child_stats` rollup (nullable when leaf) and
 *  -- when the session is a for_each parent -- the ordered per-iteration
 *  list. */
export interface SessionWithChildStats extends Session {
  child_stats: SessionChildStats | null;
  child_iterations?: SessionChildIteration[];
}

/**
 * Recursive session shape returned by `session/tree`. Each node carries its own
 * `child_stats` (or null for leaves) plus the nested `children` array.
 */
export interface SessionWithChildren extends SessionWithChildStats {
  children: SessionWithChildren[];
}
