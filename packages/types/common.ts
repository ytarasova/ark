// ── Profile ──────────────────────────────────────────────────────────────────

export interface Profile {
  name: string;
  description?: string;
  config?: Record<string, unknown>;
  createdAt: string;
}

// ── Tool entry ────────────────────────────────────────────────────────────────

export interface ToolEntry {
  kind: "mcp-server" | "command" | "claude-skill" | "ark-skill" | "ark-recipe" | "context";
  name: string;
  description: string;
  source: string;
  config?: Record<string, unknown>;
}

// ── Memory ────────────────────────────────────────────────────────────────────

export interface MemoryEntry {
  id: string;
  content: string;
  tags: string[];
  scope: string;
  importance: number;
  createdAt: string;
  accessedAt: string;
  accessCount: number;
}

// ── Schedule ──────────────────────────────────────────────────────────────────

export interface Schedule {
  id: string;
  cron: string;
  flow: string;
  repo?: string;
  workdir?: string;
  summary?: string;
  compute_name?: string;
  group_name?: string;
  enabled: boolean;
  last_run?: string;
  created_at: string;
}

// ── Costs ─────────────────────────────────────────────────────────────────────

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  total_tokens: number;
}

export interface SessionCost {
  sessionId: string;
  summary: string | null;
  model: string | null;
  usage: TokenUsage | null;
  cost: number;
}

export interface SessionOpResult {
  ok: boolean;
  message: string;
  sessionId?: string;
}

export interface PortDecl {
  port: number;
  name?: string;
  source?: string;
}

export interface PortStatus extends PortDecl {
  listening: boolean;
}

export interface ComputeMetrics {
  cpu: number;
  memTotalGb: number;
  memUsedGb: number;
  memPct: number;
  diskPct: number;
  netRxMb: number;
  netTxMb: number;
  uptime: string;
  idleTicks: number;
}

export interface ComputeSessionInfo {
  name: string;
  status: string;
  mode?: string;
  projectPath?: string;
  cpu?: number;
  mem?: number;
}

export interface ComputeProcessInfo {
  pid: string | number;
  cpu: string | number;
  mem: string | number;
  command?: string;
  name?: string;
  workingDir?: string;
}

export interface DockerContainerInfo {
  name: string;
  status?: string;
  image?: string;
  cpu?: string;
  memory?: string;
  project?: string;
}

export interface ComputeSnapshot {
  metrics: ComputeMetrics;
  sessions: ComputeSessionInfo[];
  processes: ComputeProcessInfo[];
  docker: DockerContainerInfo[];
}

export interface HookPayload {
  event?: string;
  session_id?: string;
  matcher?: string;
  tool_name?: string;
  [key: string]: unknown;
}

export interface AgentReport {
  type: "progress" | "completed" | "error" | "question";
  message?: string;
  summary?: string;
  error?: string;
  usage?: { input_tokens?: number; output_tokens?: number; total_cost?: number };
  [key: string]: unknown;
}

export interface SpawnOpts {
  task: string;
  agent?: string;
  model?: string;
  group_name?: string;
}

export interface WaitOpts {
  timeoutMs?: number;
  pollMs?: number;
  onStatus?: (status: string) => void;
}

export interface WorktreeFinishOpts {
  into?: string;
  noMerge?: boolean;
  keepBranch?: boolean;
}
