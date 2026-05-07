/**
 * Minimal JSON-RPC client for the e2e suite. Stays deliberately thin --
 * the real ArkClient at packages/protocol/ pulls a lot of typed surface
 * we don't need here, and using fetch directly keeps the test loop a
 * close mirror of how an external operator would script it.
 */

let nextId = 1;

export class RpcClient {
  constructor(private readonly baseUrl: string) {}

  async call<T = unknown>(method: string, params?: unknown): Promise<T> {
    const id = nextId++;
    const body = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    const r = await fetch(`${this.baseUrl}/api/rpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    if (!r.ok) throw new Error(`RPC ${method} HTTP ${r.status}: ${await r.text()}`);
    const json = (await r.json()) as { result?: T; error?: { code: number; message: string } };
    if (json.error) throw new Error(`RPC ${method} error: ${json.error.message}`);
    return json.result as T;
  }
}

/** Poll a predicate against a fresh RPC call until it returns truthy or timeout. */
export async function waitFor<T>(
  fn: () => Promise<T>,
  predicate: (value: T) => boolean,
  opts: { timeoutMs: number; intervalMs?: number; description?: string },
): Promise<T> {
  const interval = opts.intervalMs ?? 500;
  const deadline = Date.now() + opts.timeoutMs;
  let last: T | undefined;
  while (Date.now() < deadline) {
    last = await fn();
    if (predicate(last)) return last;
    await Bun.sleep(interval);
  }
  throw new Error(
    `waitFor timed out after ${opts.timeoutMs}ms${opts.description ? ` (${opts.description})` : ""}; last value: ${JSON.stringify(last)}`,
  );
}
