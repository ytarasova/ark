import { RpcError } from "../protocol/types.js";

export function rpcError(code: number, message: string): RpcError {
  return new RpcError(message, code);
}

export function extract<T>(params: Record<string, unknown> | undefined, required: (keyof T)[]): T {
  if (!params) throw new RpcError("Missing params", -32602);
  for (const key of required) {
    if (params[key as string] === undefined) {
      throw new RpcError(`Missing required param: ${String(key)}`, -32602);
    }
  }
  return params as T;
}
