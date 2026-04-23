/**
 * LLM Router -- types for request/response, routing decisions, provider config.
 *
 * All types follow OpenAI's chat completions API, with router-specific extensions
 * under the `routing` key.
 */

// ── OpenAI-compatible message types ──────────────────────────────────────────

export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ContentPart[] | null;
  name?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ContentPart {
  type: "text" | "image_url";
  text?: string;
  image_url?: { url: string; detail?: "low" | "high" | "auto" };
}

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface Tool {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

// ── Chat completion request/response ─────────────────────────────────────────

export interface ChatCompletionRequest {
  model: string; // "auto" for routing, or specific model
  messages: Message[];
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  stop?: string | string[];
  tools?: Tool[];
  tool_choice?: string | object;
  stream?: boolean;
  // Router extensions
  routing?: RoutingOptions;
}

export interface RoutingOptions {
  /**
   * Routing policy identifier. The three shipped policies are "quality",
   * "balanced", and "cost"; additional values are accepted and resolved
   * against any custom policies the engine has registered.
   */
  policy?: string;
  quality_floor?: number; // 0-1, minimum quality threshold
  max_cost_per_token?: number;
  sticky_session_id?: string; // multi-turn session tracking
  preferred_providers?: string[];
  excluded_models?: string[];
}

export interface Choice {
  index: number;
  message: Message;
  finish_reason: "stop" | "length" | "tool_calls" | "content_filter" | null;
}

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface ChatCompletionResponse {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: Choice[];
  usage: Usage;
  // Router extension
  routing?: RoutingDecision;
}

// ── Streaming types ──────────────────────────────────────────────────────────

export interface ChatCompletionChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: ChunkChoice[];
  usage?: Usage | null;
}

export interface ChunkChoice {
  index: number;
  delta: Partial<Message>;
  finish_reason: "stop" | "length" | "tool_calls" | "content_filter" | null;
}

// ── Routing decision ─────────────────────────────────────────────────────────

export interface RoutingDecision {
  selected_model: string;
  selected_provider: string;
  reason: string;
  alternatives_considered: Array<{
    model: string;
    reason_skipped: string;
  }>;
  latency_ms: {
    classification: number;
    routing: number;
    total_overhead: number;
  };
  complexity: {
    score: number; // 0-1
    task_type: string; // generation, reasoning, code, extraction, chat
    has_tools: boolean;
    estimated_difficulty: Difficulty;
  };
}

export type Difficulty = "trivial" | "simple" | "moderate" | "complex" | "expert";

// ── Provider and model configuration ─────────────────────────────────────────

export interface ProviderConfig {
  name: string; // "anthropic", "openai", "google", "ollama"
  api_key?: string;
  base_url: string;
  models: ModelConfig[];
  timeout_ms?: number; // default: 30000
  max_retries?: number; // default: 2
}

export interface ModelConfig {
  id: string; // "claude-sonnet-4-6"
  provider: string; // "anthropic", "openai", "google", "ollama"
  tier: "frontier" | "standard" | "economy";
  cost_input: number; // USD per 1M input tokens
  cost_output: number; // USD per 1M output tokens
  max_context: number; // max tokens in context window
  supports_tools: boolean;
  quality: number; // 0-1, initial quality estimate
}

export type RoutingPolicy = "quality" | "balanced" | "cost";

export interface RouterConfig {
  port: number;
  policy: RoutingPolicy;
  quality_floor: number; // 0-1, default: 0.8
  providers: ProviderConfig[];
  sticky_session_ttl_ms: number; // default: 3600000 (1 hour)
  cascade_enabled: boolean;
  cascade_confidence_threshold: number; // default: 0.7
  log_decisions: boolean;
}

// ── Feedback and stats ───────────────────────────────────────────────────────

export interface CostEntry {
  model: string;
  provider: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  timestamp: number;
  session_id?: string;
}

export interface CostSummary {
  key: string; // model name, provider, or session id
  total_cost_usd: number;
  total_input_tokens: number;
  total_output_tokens: number;
  request_count: number;
}

export interface RouterStats {
  total_requests: number;
  routed_requests: number; // model: "auto"
  passthrough_requests: number; // specific model
  requests_by_model: Record<string, number>;
  requests_by_provider: Record<string, number>;
  requests_by_tier: Record<string, number>;
  avg_classification_ms: number;
  avg_routing_ms: number;
  total_cost_usd: number;
  uptime_ms: number;
  started_at: number;
  errors: number;
  fallbacks: number;
}

// ── Circuit breaker ──────────────────────────────────────────────────────────

export interface CircuitBreakerState {
  failures: number;
  last_failure: number;
  state: "closed" | "open" | "half-open";
  next_attempt: number; // timestamp when to try again
}
