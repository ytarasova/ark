export type SessionStatus =
  | "pending" | "ready" | "running" | "waiting"
  | "stopped" | "blocked" | "completed" | "failed" | "deleting";

export interface SessionUsage {
  input_tokens?: number;
  output_tokens?: number;
  total_cost?: number;
}

export interface SessionConfig {
  // Runtime
  usage?: SessionUsage;
  turns?: number;
  model_override?: string;
  completion_summary?: string;
  filesChanged?: string[];
  commits?: string[];
  github_url?: string;
  ports?: Array<{ port: number; name?: string; source?: string }>;
  // Compute/infra
  remoteWorkdir?: string;
  worktree?: string;
  // Lifecycle
  _pre_delete_status?: string;
  _deleted_at?: string;
  _pending_handoff?: { agent: string; instructions?: string };
  // Skills attached to session
  skills?: string[];
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
  config: SessionConfig;
  created_at: string;
  updated_at: string;
}

export interface CreateSessionOpts {
  ticket?: string;
  summary?: string;
  repo?: string;
  flow?: string;
  agent?: string | null;
  compute_name?: string;
  workdir?: string;
  group_name?: string;
  config?: Partial<SessionConfig>;
}

export interface SessionListFilters {
  status?: SessionStatus;
  repo?: string;
  group_name?: string;
  parent_id?: string;
  flow?: string;
  limit?: number;
}
