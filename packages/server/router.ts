import {
  createResponse,
  createErrorResponse,
  ErrorCodes,
  RpcError,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type JsonRpcError,
} from "../protocol/types.js";
import { validateRequest } from "./validate.js";

export type NotifyFn = (method: string, params?: Record<string, unknown>) => void;
export type Handler = (params: Record<string, unknown>, notify: NotifyFn) => Promise<unknown>;

export class Router {
  private handlers = new Map<string, Handler>();
  private initialized = false;
  private requireInit = false;

  handle(method: string, handler: Handler): void {
    this.handlers.set(method, handler);
  }

  requireInitialization(): void {
    this.requireInit = true;
  }

  markInitialized(): void {
    this.initialized = true;
  }

  async dispatch(req: JsonRpcRequest, notify?: NotifyFn): Promise<JsonRpcResponse | JsonRpcError> {
    if (this.requireInit && !this.initialized && req.method !== "initialize") {
      return createErrorResponse(req.id, ErrorCodes.NOT_INITIALIZED, "Not initialized -- call initialize first");
    }

    const handler = this.handlers.get(req.method);
    if (!handler) {
      return createErrorResponse(req.id, ErrorCodes.METHOD_NOT_FOUND, `Unknown method: ${req.method}`);
    }

    try {
      // Validate request params against the Zod schema registered for this
      // method (if any). Methods without a schema pass through unchanged so
      // handlers using the legacy `extract<T>` helper keep working.
      const params = validateRequest(req.method, req.params);
      const noop: NotifyFn = () => {};
      const result = await handler(params, notify ?? noop);
      return createResponse(req.id, result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const code = err instanceof RpcError ? err.code : ErrorCodes.INTERNAL_ERROR;
      return createErrorResponse(req.id, code, message);
    }
  }
}
