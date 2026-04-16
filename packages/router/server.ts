/**
 * LLM Router -- HTTP server.
 *
 * Bun.serve() server exposing an OpenAI-compatible API at /v1/chat/completions.
 * Handles both streaming and non-streaming requests. Adds routing metadata to
 * responses.
 *
 * Routes:
 *   POST /v1/chat/completions  -- main endpoint (auto-route or passthrough)
 *   GET  /v1/router/stats      -- routing statistics
 *   GET  /v1/router/costs      -- cost breakdown
 *   GET  /health               -- health check
 */

import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatCompletionChunk,
  RouterConfig,
  RoutingDecision,
  ModelConfig,
} from "./types.js";
import { classify } from "./classifier.js";
import { RoutingEngine } from "./engine.js";
import { Dispatcher, TensorZeroDispatcher } from "./dispatch.js";
import { FeedbackTracker } from "./feedback.js";
import { ProviderRegistry } from "./providers.js";
import { DEFAULT_CHANNEL_BASE_URL } from "../core/constants.js";

export interface RouterServer {
  stop(): void;
  port: number;
  url: string;
}

export interface RouterUsageEvent {
  model: string;
  provider: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
}

export interface RouterStartOpts {
  /** TensorZero gateway URL. When set, dispatches go through TensorZero instead of direct provider adapters. */
  tensorZeroUrl?: string;
  /** Called after each successful dispatch with usage data. Wire to UsageRecorder for persistent cost tracking. */
  onUsage?: (event: RouterUsageEvent) => void;
}

export function startRouter(config: RouterConfig, opts?: RouterStartOpts): RouterServer {
  // ── Initialize components ──────────────────────────────────────────────

  const registry = new ProviderRegistry();
  for (const p of config.providers) {
    registry.register(p);
  }

  const engine = new RoutingEngine(registry, config);
  const dispatcher = new Dispatcher(registry);
  const feedback = new FeedbackTracker();

  // TensorZero dispatcher (used when TensorZero gateway is available)
  const tensorZeroUrl = opts?.tensorZeroUrl ?? process.env.ARK_TENSORZERO_URL;
  const tzDispatcher = tensorZeroUrl ? new TensorZeroDispatcher(tensorZeroUrl) : null;

  console.error(
    `[router] Starting on port ${config.port}, policy=${config.policy}, providers=${config.providers.map((p) => p.name).join(",")}`,
  );
  if (tzDispatcher) {
    console.error(`[router] TensorZero gateway: ${tensorZeroUrl}`);
  }
  console.error(
    `[router] Models: ${registry
      .listModels()
      .map((m) => m.id)
      .join(", ")}`,
  );

  // ── HTTP server ────────────────────────────────────────────────────────

  const server = Bun.serve({
    port: config.port,
    hostname: "0.0.0.0",

    async fetch(req) {
      const url = new URL(req.url);

      try {
        // Health check
        if (url.pathname === "/health") {
          return Response.json({
            ok: true,
            uptime_ms: Date.now() - feedback.getStats().started_at,
            providers: config.providers.map((p) => p.name),
            models: registry.listModels().length,
          });
        }

        // Router stats
        if (url.pathname === "/v1/router/stats" && req.method === "GET") {
          return Response.json(feedback.getStats());
        }

        // Cost summary
        if (url.pathname === "/v1/router/costs" && req.method === "GET") {
          const params = url.searchParams;
          const groupBy = params.get("group_by") as "model" | "provider" | "session" | undefined;
          return Response.json(feedback.getCostSummary({ groupBy: groupBy ?? "model" }));
        }

        // Chat completions
        if (url.pathname === "/v1/chat/completions" && req.method === "POST") {
          const request = (await req.json()) as ChatCompletionRequest;
          return await handleChatCompletion(
            request,
            registry,
            engine,
            dispatcher,
            feedback,
            config,
            tzDispatcher,
            opts?.onUsage,
          );
        }

        // List models (OpenAI-compatible)
        if (url.pathname === "/v1/models" && req.method === "GET") {
          const models = registry.listModels().map((m) => ({
            id: m.id,
            object: "model",
            created: Math.floor(Date.now() / 1000),
            owned_by: m.provider,
          }));
          return Response.json({ object: "list", data: models });
        }

        return new Response("Not Found", { status: 404 });
      } catch (err) {
        console.error(`[router] Error handling ${url.pathname}: ${(err as Error).message}`);
        return Response.json({ error: { message: (err as Error).message, type: "server_error" } }, { status: 500 });
      }
    },
  });

  return {
    stop: () => {
      engine.stop();
      server.stop();
    },
    port: server.port,
    url: `${DEFAULT_CHANNEL_BASE_URL}:${server.port}`,
  };
}

// ── Chat completion handler ──────────────────────────────────────────────────

async function handleChatCompletion(
  request: ChatCompletionRequest,
  registry: ProviderRegistry,
  engine: RoutingEngine,
  dispatcher: Dispatcher,
  feedback: FeedbackTracker,
  config: RouterConfig,
  tzDispatcher: TensorZeroDispatcher | null,
  onUsage?: (event: RouterUsageEvent) => void,
): Promise<Response> {
  const isAutoRoute = request.model === "auto";

  // ── Passthrough mode (specific model requested) ────────────────────────

  if (!isAutoRoute) {
    // TensorZero passthrough: if available, route specific models through TZ
    if (tzDispatcher) {
      return handleTensorZeroPassthrough(request, tzDispatcher, feedback);
    }
    return handlePassthrough(request, registry, dispatcher, feedback);
  }

  // ── Auto-route mode ────────────────────────────────────────────────────

  const t0 = performance.now();

  // Classify
  const classification = classify(request);
  const classificationMs = performance.now() - t0;

  // Route
  const decision = engine.route(request, classification);
  decision.latency_ms.classification = classificationMs;
  decision.latency_ms.total_overhead = performance.now() - t0;

  if (config.log_decisions) {
    console.error(
      `[router] Route: ${decision.selected_model} (${decision.reason}) [${decision.latency_ms.total_overhead.toFixed(1)}ms]`,
    );
  }

  const model = registry.findModel(decision.selected_model);

  // ── TensorZero dispatch (if available) ─────────────────────────────────

  if (tzDispatcher) {
    if (request.stream) {
      return handleStreamingTZ(request, decision, tzDispatcher, feedback, model);
    }

    try {
      const response = await tzDispatcher.dispatch(request, decision);
      response.routing = decision;
      // Record usage from TensorZero response
      if (response.usage && model) {
        feedback.logDecision(decision, response, model);
        emitUsage(onUsage, decision, response, model);
      }
      return Response.json(response);
    } catch (err) {
      feedback.logFailure(decision.selected_model, (err as Error).message);
      feedback.logFallback();
      return Response.json(
        { error: { message: (err as Error).message, type: "tensorzero_error", routing: decision } },
        { status: 502 },
      );
    }
  }

  // ── Fallback to direct provider dispatch (no TensorZero) ───────────────

  // ── Streaming response ─────────────────────────────────────────────────

  if (request.stream) {
    return handleStreamingRoute(request, decision, dispatcher, feedback, model);
  }

  // ── Non-streaming response ─────────────────────────────────────────────

  try {
    // Cascade mode
    if (config.cascade_enabled && classification.score < 0.5) {
      const cascadeModels = registry
        .listModels()
        .filter((m) => m.supports_tools || !classification.has_tools)
        .sort((a, b) => a.cost_input + a.cost_output - (b.cost_input + b.cost_output));

      if (cascadeModels.length > 1) {
        const response = await dispatcher.cascade(request, cascadeModels, config.cascade_confidence_threshold);
        response.routing = decision;
        feedback.logDecision(decision, response, model);
        emitUsage(onUsage, decision, response, model);
        return Response.json(response);
      }
    }

    const response = await dispatcher.dispatch(request, decision);
    response.routing = decision;
    feedback.logDecision(decision, response, model);
    emitUsage(onUsage, decision, response, model);
    return Response.json(response);
  } catch (err) {
    feedback.logFailure(decision.selected_model, (err as Error).message);
    feedback.logFallback();
    return Response.json(
      { error: { message: (err as Error).message, type: "router_error", routing: decision } },
      { status: 502 },
    );
  }
}

// ── Usage callback ──────────────────────────────────────────────────────────

function emitUsage(
  onUsage: ((event: RouterUsageEvent) => void) | undefined,
  decision: RoutingDecision,
  response: ChatCompletionResponse,
  model: ModelConfig | undefined,
): void {
  if (!onUsage || !response.usage || !model) return;
  const inputCost = (response.usage.prompt_tokens / 1_000_000) * model.cost_input;
  const outputCost = (response.usage.completion_tokens / 1_000_000) * model.cost_output;
  onUsage({
    model: decision.selected_model,
    provider: decision.selected_provider,
    input_tokens: response.usage.prompt_tokens,
    output_tokens: response.usage.completion_tokens,
    cost_usd: inputCost + outputCost,
  });
}

// ── Passthrough handler ──────────────────────────────────────────────────────

async function handlePassthrough(
  request: ChatCompletionRequest,
  registry: ProviderRegistry,
  dispatcher: Dispatcher,
  feedback: FeedbackTracker,
): Promise<Response> {
  const provider = registry.findProviderForModel(request.model);
  if (!provider) {
    return Response.json(
      {
        error: {
          message: `Model '${request.model}' not found in any registered provider`,
          type: "invalid_request_error",
        },
      },
      { status: 400 },
    );
  }

  feedback.logPassthrough(request.model, provider.config.name);

  if (request.stream) {
    return handleStreamingPassthrough(request, provider, request.model);
  }

  try {
    const response = await provider.complete(request, request.model);
    return Response.json(response);
  } catch (err) {
    feedback.logFailure(request.model, (err as Error).message);
    return Response.json({ error: { message: (err as Error).message, type: "provider_error" } }, { status: 502 });
  }
}

// ── Streaming handlers ───────────────────────────────────────────────────────

function handleStreamingRoute(
  request: ChatCompletionRequest,
  decision: any,
  dispatcher: Dispatcher,
  feedback: FeedbackTracker,
  _model: any,
): Response {
  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      let firstChunk = true;

      try {
        for await (const chunk of dispatcher.dispatchStream(request, decision)) {
          // Add routing metadata to the first chunk
          if (firstChunk) {
            (chunk as ChatCompletionChunk & { routing?: unknown }).routing = decision;
            firstChunk = false;
          }
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
        }
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      } catch (err) {
        feedback.logFailure(decision.selected_model, (err as Error).message);
        const errorChunk = {
          error: { message: (err as Error).message, type: "stream_error" },
        };
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(errorChunk)}\n\n`));
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

function handleStreamingPassthrough(request: ChatCompletionRequest, provider: any, modelId: string): Response {
  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();

      try {
        for await (const chunk of provider.stream(request, modelId)) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
        }
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      } catch (err) {
        const errorChunk = {
          error: { message: (err as Error).message, type: "stream_error" },
        };
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(errorChunk)}\n\n`));
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

// ── TensorZero handlers ─────────────────────────────────────────────────────

/**
 * Handle a passthrough request through TensorZero (specific model, no routing).
 */
async function handleTensorZeroPassthrough(
  request: ChatCompletionRequest,
  tzDispatcher: TensorZeroDispatcher,
  feedback: FeedbackTracker,
): Promise<Response> {
  feedback.logPassthrough(request.model, "tensorzero");

  if (request.stream) {
    return handleStreamingTZPassthrough(request, tzDispatcher);
  }

  const passthroughDecision = {
    selected_model: request.model,
    selected_provider: "tensorzero",
    reason: "passthrough",
    alternatives_considered: [],
    latency_ms: { classification: 0, routing: 0, total_overhead: 0 },
    complexity: { score: 0, task_type: "passthrough", has_tools: false, estimated_difficulty: "simple" as const },
  };

  try {
    const response = await tzDispatcher.dispatch(request, passthroughDecision);
    return Response.json(response);
  } catch (err) {
    feedback.logFailure(request.model, (err as Error).message);
    return Response.json({ error: { message: (err as Error).message, type: "tensorzero_error" } }, { status: 502 });
  }
}

/**
 * Handle a streaming passthrough request through TensorZero.
 */
function handleStreamingTZPassthrough(request: ChatCompletionRequest, tzDispatcher: TensorZeroDispatcher): Response {
  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      // Build a minimal routing decision for the stream helper
      const passthroughDecision = {
        selected_model: request.model,
        selected_provider: "tensorzero",
        reason: "passthrough",
        alternatives_considered: [],
        latency_ms: { classification: 0, routing: 0, total_overhead: 0 },
        complexity: { score: 0, task_type: "passthrough", has_tools: false, estimated_difficulty: "simple" as const },
      };

      try {
        for await (const chunk of tzDispatcher.stream(request, passthroughDecision)) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
        }
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      } catch (err) {
        const errorChunk = {
          error: { message: (err as Error).message, type: "stream_error" },
        };
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(errorChunk)}\n\n`));
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

/**
 * Handle a streaming auto-routed request through TensorZero.
 */
function handleStreamingTZ(
  request: ChatCompletionRequest,
  decision: any,
  tzDispatcher: TensorZeroDispatcher,
  feedback: FeedbackTracker,
  _model: any,
): Response {
  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      let firstChunk = true;

      try {
        for await (const chunk of tzDispatcher.stream(request, decision)) {
          if (firstChunk) {
            (chunk as ChatCompletionChunk & { routing?: unknown }).routing = decision;
            firstChunk = false;
          }
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
        }
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      } catch (err) {
        feedback.logFailure(decision.selected_model, (err as Error).message);
        const errorChunk = {
          error: { message: (err as Error).message, type: "stream_error" },
        };
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(errorChunk)}\n\n`));
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
