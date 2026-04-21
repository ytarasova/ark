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
  FORBIDDEN: -32006,
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

// ── RPC Error class ────────────────────────────────────────────────────────

/** Error with a numeric JSON-RPC error code. Thrown by RPC handlers. */
export class RpcError extends Error {
  code: number;
  data?: unknown;
  constructor(message: string, code: number, data?: unknown) {
    super(message);
    this.name = "RpcError";
    this.code = code;
    if (data !== undefined) this.data = data;
  }
}

// ── Version ─────────────────────────────────────────────────────────────────

export const ARK_VERSION = "0.8.0";
