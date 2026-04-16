/**
 * Burn module types -- ported from AgentSeal/codeburn (MIT).
 * https://github.com/AgentSeal/codeburn
 *
 * Adapted for Ark: dropped Cursor-specific fields (languages),
 * added Ark-specific fields (BurnPeriod, BurnSummaryResponse).
 */

// ---------------------------------------------------------------------------
// Token usage
// ---------------------------------------------------------------------------

export type TokenUsageBurn = {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  cachedInputTokens: number;
  reasoningTokens: number;
  webSearchRequests: number;
};

// ---------------------------------------------------------------------------
// Content blocks (from transcript JSON)
// ---------------------------------------------------------------------------

export type ToolUseBlock = {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
};

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | ToolUseBlock
  | { type: string; [key: string]: unknown };

// ---------------------------------------------------------------------------
// API-level types (raw transcript shapes)
// ---------------------------------------------------------------------------

export type ApiUsage = {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  server_tool_use?: {
    web_search_requests?: number;
    web_fetch_requests?: number;
  };
  speed?: "standard" | "fast";
};

export type AssistantMessageContent = {
  model: string;
  id?: string;
  type: "message";
  role: "assistant";
  content: ContentBlock[];
  usage: ApiUsage;
  stop_reason?: string;
};

export type JournalEntry = {
  type: string;
  uuid?: string;
  parentUuid?: string | null;
  timestamp?: string;
  sessionId?: string;
  cwd?: string;
  version?: string;
  gitBranch?: string;
  promptId?: string;
  message?:
    | AssistantMessageContent
    | { role: "user"; content: string | ContentBlock[] };
  isSidechain?: boolean;
  [key: string]: unknown;
};

// ---------------------------------------------------------------------------
// Parsed turn (pre-classification)
// ---------------------------------------------------------------------------

export type ParsedApiCall = {
  provider: string;
  model: string;
  usage: TokenUsageBurn;
  costUSD: number;
  tools: string[];
  mcpTools: string[];
  hasAgentSpawn: boolean;
  hasPlanMode: boolean;
  speed: "standard" | "fast";
  timestamp: string;
  bashCommands: string[];
  deduplicationKey: string;
};

export type ParsedTurn = {
  userMessage: string;
  assistantCalls: ParsedApiCall[];
  timestamp: string;
  sessionId: string;
};

// ---------------------------------------------------------------------------
// Task categories (13 categories matching codeburn)
// ---------------------------------------------------------------------------

export type TaskCategory =
  | "coding"
  | "debugging"
  | "feature"
  | "refactoring"
  | "testing"
  | "exploration"
  | "planning"
  | "delegation"
  | "git"
  | "build/deploy"
  | "conversation"
  | "brainstorming"
  | "general";

export const CATEGORY_LABELS: Record<TaskCategory, string> = {
  coding: "Coding",
  debugging: "Debugging",
  feature: "Feature Dev",
  refactoring: "Refactoring",
  testing: "Testing",
  exploration: "Exploration",
  planning: "Planning",
  delegation: "Delegation",
  git: "Git Ops",
  "build/deploy": "Build/Deploy",
  conversation: "Conversation",
  brainstorming: "Brainstorming",
  general: "General",
};

// ---------------------------------------------------------------------------
// Classified turn (post-classification)
// ---------------------------------------------------------------------------

export type ClassifiedTurn = ParsedTurn & {
  category: TaskCategory;
  retries: number;
  hasEdits: boolean;
  isOneShot: boolean;
};

// ---------------------------------------------------------------------------
// Session / project summaries
// ---------------------------------------------------------------------------

export type SessionSummary = {
  sessionId: string;
  project: string;
  firstTimestamp: string;
  lastTimestamp: string;
  totalCostUSD: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheWriteTokens: number;
  apiCalls: number;
  turns: ClassifiedTurn[];
  modelBreakdown: Record<
    string,
    { calls: number; costUSD: number; tokens: TokenUsageBurn }
  >;
  toolBreakdown: Record<string, { calls: number }>;
  mcpBreakdown: Record<string, { calls: number }>;
  bashBreakdown: Record<string, { calls: number }>;
  categoryBreakdown: Record<
    TaskCategory,
    {
      turns: number;
      costUSD: number;
      retries: number;
      editTurns: number;
      oneShotTurns: number;
    }
  >;
};

export type ProjectSummary = {
  project: string;
  projectPath: string;
  sessions: SessionSummary[];
  totalCostUSD: number;
  totalApiCalls: number;
};

// ---------------------------------------------------------------------------
// Date range
// ---------------------------------------------------------------------------

export type DateRange = {
  start: Date;
  end: Date;
};

// ---------------------------------------------------------------------------
// Burn dashboard API types (Ark-specific)
// ---------------------------------------------------------------------------

export type BurnPeriod = "today" | "week" | "30days" | "month";

export type BurnSummaryResponse = {
  period: BurnPeriod;
  dateRange: { start: string; end: string };
  overview: {
    totalCostUsd: number;
    totalApiCalls: number;
    totalSessions: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalCacheReadTokens: number;
    totalCacheWriteTokens: number;
    cacheHitPct: number;
  };
  daily: Array<{ date: string; cost: number; calls: number }>;
  byProject: Array<{ project: string; cost: number; sessions: number }>;
  byModel: Array<{
    model: string;
    cost: number;
    calls: number;
    inputTokens: number;
    outputTokens: number;
  }>;
  byCategory: Array<{
    category: TaskCategory;
    cost: number;
    turns: number;
    oneShotPct: number | null;
    editTurns: number;
  }>;
  coreTools: Array<{ tool: string; calls: number }>;
  mcpServers: Array<{ tool: string; calls: number }>;
  bashCommands: Array<{ cmd: string; calls: number }>;
  runtimeCoverage: {
    hasToolData: boolean;
    hasBashData: boolean;
    hasMcpData: boolean;
    hasOneShotData: boolean;
  };
};
