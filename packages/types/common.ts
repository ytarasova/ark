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
  uptime: string;
}

export interface ComputeSnapshot {
  metrics: ComputeMetrics;
  sessions: Array<{ name: string; status: string }>;
  processes: Array<{ pid: number; name: string; cpu: number; mem: number }>;
  docker: Array<{ name: string; status: string; image: string }>;
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
