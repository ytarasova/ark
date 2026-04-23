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
  model_override?: string;
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
  // Lifecycle
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
  created_at: string;
  updated_at: string;
}

export interface SessionInputs {
  /** Role-keyed absolute paths to files the session should consume. */
  files?: Record<string, string>;
  /** Arbitrary k=v params. Flattened into `{inputs.params.<key>}` templating. */
  params?: Record<string, string>;
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
  flow?: string;
  agent?: string | null;
  compute_name?: string;
  workdir?: string;
  group_name?: string;
  config?: Partial<SessionConfig>;
  user_id?: string;
  /** Workspace id for workspace-scoped dispatch. Null/undefined = legacy repo-only. */
  workspace_id?: string | null;
  inputs?: SessionInputs;
  attachments?: Array<{ name: string; content: string; type: string }>;
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

/** Session row with an attached `child_stats` rollup (nullable when leaf). */
export interface SessionWithChildStats extends Session {
  child_stats: SessionChildStats | null;
}

/**
 * Recursive session shape returned by `session/tree`. Each node carries its own
 * `child_stats` (or null for leaves) plus the nested `children` array.
 */
export interface SessionWithChildren extends SessionWithChildStats {
  children: SessionWithChildren[];
}
