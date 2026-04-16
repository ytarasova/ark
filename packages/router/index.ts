/**
 * LLM Router -- public API.
 *
 * Exports all router components and the startRouter entry point.
 */

// Types
export type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatCompletionChunk,
  RoutingDecision,
  RoutingOptions,
  RouterConfig,
  ProviderConfig,
  ModelConfig,
  RoutingPolicy,
  Message,
  Tool,
  ToolCall,
  Choice,
  Usage,
  ChunkChoice,
  ContentPart,
  CostEntry,
  CostSummary,
  RouterStats,
  CircuitBreakerState,
  Difficulty,
} from "./types.js";

// Config
export {
  loadRouterConfig,
  allModels,
  findModel,
  findProviderForModel,
  DEFAULT_MODELS,
  DEFAULT_ROUTER_PORT,
} from "./config.js";

// Providers
export { ProviderRegistry, Provider } from "./providers.js";

// Classifier
export { classify, type ClassificationResult } from "./classifier.js";

// Engine
export { RoutingEngine } from "./engine.js";

// Dispatcher
export { Dispatcher, TensorZeroDispatcher } from "./dispatch.js";

// Feedback
export { FeedbackTracker } from "./feedback.js";

// Server
export { startRouter, type RouterServer, type RouterStartOpts, type RouterUsageEvent } from "./server.js";
