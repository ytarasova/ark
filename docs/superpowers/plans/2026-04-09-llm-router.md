# LLM Router Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an OpenAI-compatible LLM proxy that routes requests to the optimal model based on complexity, cost, and quality policies. Runs standalone or pooled on ArkD. Integrates with Ark via `model: auto` in agent YAML.

**Architecture:** HTTP server exposing `/v1/chat/completions`. Classifies request complexity, selects model via routing policy, dispatches to provider with fallback. Logs every decision for observability. Learns from outcomes via bandit-based feedback.

**Tech Stack:** TypeScript, Bun, Bun.serve()

---

## File Map

| File | Responsibility |
|------|---------------|
| `packages/router/server.ts` | HTTP server -- OpenAI-compatible API |
| `packages/router/classifier.ts` | Request complexity scoring (rule-based v1) |
| `packages/router/engine.ts` | Routing decision engine (policy modes) |
| `packages/router/dispatch.ts` | Provider dispatch with fallback + circuit breakers |
| `packages/router/feedback.ts` | Quality tracking + cost attribution |
| `packages/router/providers.ts` | Provider registry (Anthropic, OpenAI, Google, self-hosted) |
| `packages/router/config.ts` | Router configuration types + loader |
| `packages/router/types.ts` | Request/response types, routing metadata |
| `packages/router/index.ts` | Exports + CLI entry |
| `packages/router/__tests__/` | Tests |

---

### Task 1: Types and Configuration

**Create:** `packages/router/types.ts`

```ts
// OpenAI-compatible request/response types
export interface ChatCompletionRequest {
  model: string;                    // "auto" for routing, or specific model
  messages: Message[];
  temperature?: number;
  max_tokens?: number;
  tools?: Tool[];
  tool_choice?: string | object;
  stream?: boolean;
  // Router extensions
  routing?: RoutingOptions;
}

export interface RoutingOptions {
  policy?: "quality" | "balanced" | "cost";
  quality_floor?: number;           // 0-1, minimum quality threshold
  max_cost_per_token?: number;
  sticky_session_id?: string;       // multi-turn session tracking
  preferred_providers?: string[];
  excluded_models?: string[];
}

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
    score: number;          // 0-1
    task_type: string;      // generation, reasoning, code, extraction, etc.
    has_tools: boolean;
    estimated_difficulty: "trivial" | "simple" | "moderate" | "complex" | "expert";
  };
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

export interface ProviderConfig {
  name: string;                     // "anthropic", "openai", "google", "ollama"
  api_key?: string;
  base_url: string;
  models: ModelConfig[];
  timeout_ms?: number;
  max_retries?: number;
}

export interface ModelConfig {
  id: string;                       // "claude-sonnet-4-6"
  tier: "frontier" | "standard" | "economy";
  cost_per_input_token: number;     // USD per token
  cost_per_output_token: number;
  max_context: number;
  supports_tools: boolean;
  supports_vision: boolean;
  quality_score: number;            // 0-1, initial estimate
}

export interface RouterConfig {
  port: number;
  policy: "quality" | "balanced" | "cost";
  quality_floor: number;
  providers: ProviderConfig[];
  sticky_session_ttl_ms: number;    // default: 3600000 (1 hour)
  cascade_enabled: boolean;
  cascade_confidence_threshold: number;
  log_decisions: boolean;
}
```

**Create:** `packages/router/config.ts`

Load router config from `~/.ark/router.yaml` or env vars.

---

### Task 2: Provider Registry + Dispatch

**Create:** `packages/router/providers.ts`

Registry of LLM providers with OpenAI-compatible dispatch.

```ts
export class ProviderRegistry {
  private providers: Map<string, Provider>;
  private circuitBreakers: Map<string, CircuitBreaker>;

  register(config: ProviderConfig): void;
  getProvider(name: string): Provider;
  listModels(): ModelConfig[];
  getModelsByTier(tier: string): ModelConfig[];
}

export class Provider {
  constructor(config: ProviderConfig);

  // Dispatch a chat completion request to this provider
  async complete(request: ChatCompletionRequest, model: string): Promise<ChatCompletionResponse>;

  // Stream a chat completion
  async *stream(request: ChatCompletionRequest, model: string): AsyncGenerator<ChatCompletionChunk>;
}
```

**Create:** `packages/router/dispatch.ts`

```ts
export class Dispatcher {
  constructor(registry: ProviderRegistry);

  // Dispatch with fallback and circuit breakers
  async dispatch(
    request: ChatCompletionRequest,
    decision: RoutingDecision,
  ): Promise<ChatCompletionResponse>;

  // Cascade: try cheap model, escalate if confidence low
  async cascade(
    request: ChatCompletionRequest,
    models: ModelConfig[],
    confidenceThreshold: number,
  ): Promise<ChatCompletionResponse>;
}
```

Provider adapters handle API differences:
- **Anthropic**: convert OpenAI format to/from Messages API
- **OpenAI**: pass through (native format)
- **Google**: convert to/from Gemini API
- **Ollama/vLLM**: OpenAI-compatible (pass through)

---

### Task 3: Request Classifier

**Create:** `packages/router/classifier.ts`

Rule-based v1 classifier. Analyses the request to estimate complexity.

```ts
export interface ClassificationResult {
  score: number;                // 0-1 complexity score
  task_type: string;            // "code", "reasoning", "extraction", "generation", "chat"
  difficulty: "trivial" | "simple" | "moderate" | "complex" | "expert";
  has_tools: boolean;
  context_length: number;       // total tokens in conversation
  turn_count: number;           // number of messages
  signals: string[];            // ["long_context", "multi_tool", "code_generation"]
}

export function classify(request: ChatCompletionRequest): ClassificationResult;
```

Classification signals (v1 -- rule-based, no ML):
- Message length (short = trivial, long = complex)
- Turn count (multi-turn escalates complexity)
- Tool presence (tool_choice + tools array)
- Code indicators (backticks, language keywords, file paths)
- Reasoning indicators ("explain", "analyze", "compare", "prove")
- System prompt length (long system = specialized task)

---

### Task 4: Routing Engine

**Create:** `packages/router/engine.ts`

```ts
export class RoutingEngine {
  constructor(
    private registry: ProviderRegistry,
    private config: RouterConfig,
  );

  // Make a routing decision
  route(
    request: ChatCompletionRequest,
    classification: ClassificationResult,
  ): RoutingDecision;

  // Sticky session lookup
  private getStickyModel(sessionId: string): string | null;
  private setStickyModel(sessionId: string, model: string): void;
}
```

Routing logic by policy:

**quality**: Always pick the highest-quality model.
```
frontier model (opus/gpt-4.1/gemini-pro)
```

**balanced** (default): Pick the cheapest model that meets the quality floor.
```
if complexity.score < 0.3 -> economy tier (haiku/nano/flash)
if complexity.score < 0.7 -> standard tier (sonnet/mini)
if complexity.score >= 0.7 -> frontier tier (opus/gpt-4.1)
if has_tools -> prefer models with high tool_call_success_rate
```

**cost**: Always pick the cheapest model.
```
economy tier, fallback to standard if tool support needed
```

Sticky sessions: once a model is selected for a conversation, stick with it unless complexity score jumps by >0.3 (escalation trigger).

---

### Task 5: Feedback + Cost Tracking

**Create:** `packages/router/feedback.ts`

```ts
export class FeedbackTracker {
  // Log a routing decision + outcome
  logDecision(decision: RoutingDecision, response: ChatCompletionResponse): void;

  // Log a negative signal (error, timeout, tool failure)
  logFailure(model: string, reason: string): void;

  // Get per-model quality scores (updated from outcomes)
  getModelQuality(model: string): number;

  // Get per-route cost summary
  getCostSummary(opts?: { since?: Date; groupBy?: "model" | "provider" | "session" }): CostSummary[];

  // Get routing stats
  getStats(): RouterStats;
}
```

Stores decisions in SQLite (reuse Ark's DB infrastructure) or in-memory for standalone mode.

---

### Task 6: HTTP Server

**Create:** `packages/router/server.ts`

```ts
export function startRouter(config: RouterConfig): { stop(): void; port: number } {
  const registry = new ProviderRegistry();
  for (const p of config.providers) registry.register(p);

  const engine = new RoutingEngine(registry, config);
  const dispatcher = new Dispatcher(registry);
  const feedback = new FeedbackTracker();

  const server = Bun.serve({
    port: config.port,
    hostname: "0.0.0.0",

    async fetch(req) {
      const url = new URL(req.url);

      // Health check
      if (url.pathname === "/health") return Response.json({ ok: true });

      // OpenAI-compatible chat completions
      if (url.pathname === "/v1/chat/completions" && req.method === "POST") {
        const request = await req.json() as ChatCompletionRequest;

        // If specific model requested, pass through (no routing)
        if (request.model !== "auto") {
          return passthrough(request, registry, dispatcher);
        }

        // Classify + route + dispatch
        const classification = classify(request);
        const decision = engine.route(request, classification);
        const response = await dispatcher.dispatch(request, decision);

        // Log for feedback
        feedback.logDecision(decision, response);

        // Attach routing metadata
        response.routing = decision;
        return Response.json(response);
      }

      // Router stats
      if (url.pathname === "/v1/router/stats") {
        return Response.json(feedback.getStats());
      }

      // Cost summary
      if (url.pathname === "/v1/router/costs") {
        return Response.json(feedback.getCostSummary());
      }

      return new Response("Not Found", { status: 404 });
    },
  });

  return { stop: () => server.stop(), port: server.port };
}
```

---

### Task 7: Ark Integration

**Modify:** `packages/core/config.ts` -- add router config section

```ts
router?: {
  enabled: boolean;
  url: string;              // default: "http://localhost:8430"
  policy: "quality" | "balanced" | "cost";
}
```

**Modify:** `packages/core/claude.ts` -- when `model: auto` and router is enabled, set `ANTHROPIC_API_BASE_URL` to router URL

**Modify:** Agent YAML schema -- add `routing_policy` and `max_cost_per_token` fields

**Add to CLI:** `packages/cli/commands/router.ts`
```bash
ark router start [--port 8430] [--policy balanced]
ark router status
ark router costs
```

---

### Task 8: ArkD Pooling

**Modify:** `packages/arkd/server.ts` -- add router as a pooled service

When ArkD starts with router enabled, it starts one router instance that all agents on that compute share. Agents get `ANTHROPIC_API_BASE_URL=http://localhost:8430/v1` injected into their environment.

---

### Task 9: Tests

**Create:** `packages/router/__tests__/classifier.test.ts`
- Trivial messages get low scores
- Code requests get high scores
- Tool requests are detected
- Multi-turn escalation

**Create:** `packages/router/__tests__/engine.test.ts`
- Quality policy always picks frontier
- Cost policy always picks economy
- Balanced respects quality floor
- Sticky sessions maintained

**Create:** `packages/router/__tests__/dispatch.test.ts`
- Provider dispatch with mock server
- Fallback on provider failure
- Circuit breaker trips after N failures

**Create:** `packages/router/__tests__/server.test.ts`
- /v1/chat/completions with model: auto routes correctly
- /v1/chat/completions with specific model passes through
- /health returns ok
- Streaming works

---

## Implementation Order

1. Types + config (Task 1) -- foundation
2. Providers + dispatch (Task 2) -- can talk to LLMs
3. Classifier (Task 3) -- can score requests
4. Engine (Task 4) -- can route
5. Server (Task 6) -- usable standalone
6. Feedback (Task 5) -- learns from outcomes
7. Ark integration (Task 7) -- model: auto works
8. ArkD pooling (Task 8) -- shared across agents
9. Tests (Task 9) -- throughout

## Success Criteria

| Metric | Target |
|--------|--------|
| Routing overhead | < 15ms P95 |
| Cost reduction (balanced) | 30-50% vs frontier-only |
| Quality maintenance | < 2% degradation |
| Availability | 99.95% (circuit breakers + fallback) |
