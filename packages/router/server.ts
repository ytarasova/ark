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

import type { ChatCompletionRequest, RouterConfig } from "./types.js";
import { classify } from "./classifier.js";
import { RoutingEngine } from "./engine.js";
import { Dispatcher } from "./dispatch.js";
import { FeedbackTracker } from "./feedback.js";
import { ProviderRegistry } from "./providers.js";
import { DEFAULT_CHANNEL_BASE_URL } from "../core/constants.js";

export interface RouterServer {
  stop(): void;
  port: number;
  url: string;
}

export function startRouter(config: RouterConfig): RouterServer {
  // ── Initialize components ──────────────────────────────────────────────

  const registry = new ProviderRegistry();
  for (const p of config.providers) {
    registry.register(p);
  }

  const engine = new RoutingEngine(registry, config);
  const dispatcher = new Dispatcher(registry);
  const feedback = new FeedbackTracker();

  console.error(`[router] Starting on port ${config.port}, policy=${config.policy}, providers=${config.providers.map(p => p.name).join(",")}`);
  console.error(`[router] Models: ${registry.listModels().map(m => m.id).join(", ")}`);

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
            providers: config.providers.map(p => p.name),
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
          const request = await req.json() as ChatCompletionRequest;
          return await handleChatCompletion(request, registry, engine, dispatcher, feedback, config);
        }

        // List models (OpenAI-compatible)
        if (url.pathname === "/v1/models" && req.method === "GET") {
          const models = registry.listModels().map(m => ({
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
        return Response.json(
          { error: { message: (err as Error).message, type: "server_error" } },
          { status: 500 },
        );
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
): Promise<Response> {
  const isAutoRoute = request.model === "auto";

  // ── Passthrough mode (specific model requested) ────────────────────────

  if (!isAutoRoute) {
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
    console.error(`[router] Route: ${decision.selected_model} (${decision.reason}) [${decision.latency_ms.total_overhead.toFixed(1)}ms]`);
  }

  const model = registry.findModel(decision.selected_model);

  // ── Streaming response ─────────────────────────────────────────────────

  if (request.stream) {
    return handleStreamingRoute(request, decision, dispatcher, feedback, model);
  }

  // ── Non-streaming response ─────────────────────────────────────────────

  try {
    // Cascade mode
    if (config.cascade_enabled && classification.score < 0.5) {
      const cascadeModels = registry.listModels()
        .filter(m => m.supports_tools || !classification.has_tools)
        .sort((a, b) => (a.cost_input + a.cost_output) - (b.cost_input + b.cost_output));

      if (cascadeModels.length > 1) {
        const response = await dispatcher.cascade(request, cascadeModels, config.cascade_confidence_threshold);
        response.routing = decision;
        feedback.logDecision(decision, response, model);
        return Response.json(response);
      }
    }

    const response = await dispatcher.dispatch(request, decision);
    response.routing = decision;
    feedback.logDecision(decision, response, model);
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
      { error: { message: `Model '${request.model}' not found in any registered provider`, type: "invalid_request_error" } },
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
    return Response.json(
      { error: { message: (err as Error).message, type: "provider_error" } },
      { status: 502 },
    );
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
            (chunk as any).routing = decision;
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
      "Connection": "keep-alive",
    },
  });
}

function handleStreamingPassthrough(
  request: ChatCompletionRequest,
  provider: any,
  modelId: string,
): Response {
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
      "Connection": "keep-alive",
    },
  });
}
