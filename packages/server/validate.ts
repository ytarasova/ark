import { RpcError, ErrorCodes } from "../protocol/types.js";
import { rpcMethodSchemas } from "../protocol/rpc-schemas.js";
import type { z } from "zod";

export function rpcError(code: number, message: string): RpcError {
  return new RpcError(message, code);
}

/**
 * Legacy presence-only extractor. Prefer the Zod schemas registered for the
 * method in `packages/protocol/rpc-schemas.ts` -- this function stays around
 * for handlers whose method is not yet covered. Once every RPC method has a
 * schema, this helper can go away.
 */
export function extract<T>(params: Record<string, unknown> | undefined, required: (keyof T)[]): T {
  if (!params) throw new RpcError("Missing params", ErrorCodes.INVALID_PARAMS);
  for (const key of required) {
    if (params[key as string] === undefined) {
      throw new RpcError(`Missing required param: ${String(key)}`, ErrorCodes.INVALID_PARAMS);
    }
  }
  return params as T;
}

/**
 * Format a ZodError issue list into a short, client-safe message (no stack).
 * Each issue becomes "<path>: <message>"; multiple issues join with "; ".
 */
function formatZodIssues(err: z.ZodError): string {
  return err.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
      return `${path}: ${issue.message}`;
    })
    .join("; ");
}

/**
 * Validate request params against the Zod schema registered for `method`.
 * Returns the parsed params (typed as `unknown` for the caller to cast to the
 * inferred type), or throws `RpcError(-32602)` on failure. Methods without a
 * registered schema are returned as-is for backwards compatibility.
 */
export function validateRequest(method: string, params: Record<string, unknown> | undefined): Record<string, unknown> {
  const schemas = rpcMethodSchemas[method];
  if (!schemas) return params ?? {};
  const result = schemas.request.safeParse(params ?? {});
  if (!result.success) {
    throw new RpcError(`Invalid params for ${method}: ${formatZodIssues(result.error)}`, ErrorCodes.INVALID_PARAMS);
  }
  return result.data as Record<string, unknown>;
}

/** True iff a Zod schema is registered for `method`. */
export function hasSchema(method: string): boolean {
  return method in rpcMethodSchemas;
}
