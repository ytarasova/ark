/**
 * Ark JSON-RPC 2.0 protocol types.
 *
 * Shared between server and client. All messages follow JSON-RPC 2.0 spec.
 */

// ── Wire Types ──────────────────────────────────────────────────────────────

export type RequestId = string | number;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: RequestId;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: RequestId;
  result: unknown;
}

export interface JsonRpcError {
  jsonrpc: "2.0";
  id: RequestId;
  error: { code: number; message: string; data?: unknown };
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcResponse | JsonRpcError | JsonRpcNotification;

// ── Error Codes ─────────────────────────────────────────────────────────────

export const ErrorCodes = {
  // Standard JSON-RPC
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  // Ark-specific
  NOT_INITIALIZED: -32001,
  SESSION_NOT_FOUND: -32002,
  EXECUTOR_ERROR: -32003,
  GATE_NOT_PENDING: -32004,
  OVERLOADED: -32005,
} as const;

// ── Constructors ────────────────────────────────────────────────────────────

export function createRequest(id: RequestId, method: string, params?: Record<string, unknown>): JsonRpcRequest {
  const req: JsonRpcRequest = { jsonrpc: "2.0", id, method };
  if (params !== undefined) req.params = params;
  return req;
}

export function createResponse(id: RequestId, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

export function createErrorResponse(id: RequestId, code: number, message: string, data?: unknown): JsonRpcError {
  const err: JsonRpcError = { jsonrpc: "2.0", id, error: { code, message } };
  if (data !== undefined) err.error.data = data;
  return err;
}

export function createNotification(method: string, params?: Record<string, unknown>): JsonRpcNotification {
  const n: JsonRpcNotification = { jsonrpc: "2.0", method };
  if (params !== undefined) n.params = params;
  return n;
}

// ── Parsing / Classification ────────────────────────────────────────────────

export function parseMessage(json: string): JsonRpcMessage {
  const msg = JSON.parse(json);
  if (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0") {
    throw new Error("Invalid JSON-RPC message: missing jsonrpc 2.0");
  }
  return msg as JsonRpcMessage;
}

export function isRequest(msg: JsonRpcMessage): msg is JsonRpcRequest {
  return "method" in msg && "id" in msg && !("error" in msg);
}

export function isResponse(msg: JsonRpcMessage): msg is JsonRpcResponse {
  return "result" in msg && "id" in msg;
}

export function isError(msg: JsonRpcMessage): msg is JsonRpcError {
  return "error" in msg && "id" in msg;
}

export function isNotification(msg: JsonRpcMessage): msg is JsonRpcNotification {
  return "method" in msg && !("id" in msg);
}

// ── Method Constants ────────────────────────────────────────────────────────

export const Methods = {
  // Initialization
  INITIALIZE: "initialize",
  INITIALIZED: "initialized",

  // Session lifecycle
  SESSION_START: "session/start",
  SESSION_DISPATCH: "session/dispatch",
  SESSION_STOP: "session/stop",
  SESSION_ADVANCE: "session/advance",
  SESSION_COMPLETE: "session/complete",
  SESSION_DELETE: "session/delete",
  SESSION_UNDELETE: "session/undelete",
  SESSION_FORK: "session/fork",
  SESSION_CLONE: "session/clone",
  SESSION_UPDATE: "session/update",
  SESSION_LIST: "session/list",
  SESSION_READ: "session/read",

  // Queries
  SESSION_EVENTS: "session/events",
  SESSION_MESSAGES: "session/messages",
  SESSION_SEARCH: "session/search",
  SESSION_CONVERSATION: "session/conversation",

  // Messaging
  MESSAGE_SEND: "message/send",
  GATE_APPROVE: "gate/approve",

  // Resources
  AGENT_LIST: "agent/list",
  FLOW_LIST: "flow/list",
  SKILL_LIST: "skill/list",
  SKILL_READ: "skill/read",
  RECIPE_LIST: "recipe/list",
  RECIPE_USE: "recipe/use",
  COMPUTE_LIST: "compute/list",
  COMPUTE_CREATE: "compute/create",
  COMPUTE_DELETE: "compute/delete",
  GROUP_LIST: "group/list",
  GROUP_CREATE: "group/create",
  GROUP_DELETE: "group/delete",

  // Config
  CONFIG_READ: "config/read",
  CONFIG_WRITE: "config/write",
  PROFILE_LIST: "profile/list",
  PROFILE_SET: "profile/set",

  // History
  HISTORY_LIST: "history/list",
  HISTORY_IMPORT: "history/import",
  HISTORY_REFRESH: "history/refresh",

  // Tools
  TOOLS_LIST: "tools/list",
  TOOLS_DELETE: "tools/delete",
  MCP_ATTACH: "mcp/attach",
  MCP_DETACH: "mcp/detach",

  // Metrics
  METRICS_SNAPSHOT: "metrics/snapshot",
  COSTS_READ: "costs/read",
} as const;

// ── Notification Names ──────────────────────────────────────────────────────

export const Notifications = {
  SESSION_UPDATED: "session/updated",
  SESSION_CREATED: "session/created",
  SESSION_DELETED: "session/deleted",
  STAGE_STARTED: "stage/started",
  STAGE_COMPLETED: "stage/completed",
  STAGE_FAILED: "stage/failed",
  EVENT_LOGGED: "event/logged",
  MESSAGE_RECEIVED: "message/received",
  OUTPUT_DELTA: "output/delta",
  GATE_REQUESTED: "gate/requested",
  METRICS_UPDATED: "metrics/updated",
  EXECUTOR_STATUS: "executor/status",
} as const;
