export function rpcError(code: number, message: string): Error {
  const err = new Error(message);
  (err as any).code = code;
  return err;
}

export function extract<T>(
  params: Record<string, unknown> | undefined,
  required: (keyof T)[],
): T {
  if (!params) throw rpcError(-32602, "Missing params");
  for (const key of required) {
    if (params[key as string] === undefined) {
      throw rpcError(-32602, `Missing required param: ${String(key)}`);
    }
  }
  return params as T;
}
