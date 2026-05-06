/**
 * Server-side helpers: Bun shims, response constructors, stream readers.
 *
 * BunLike + BunSpawnProc exist because `Bun` is a global with no static
 * type import path; we widen it to a typed shim for tests + tooling.
 */

export type BunSpawnProc = {
  pid: number;
  exitCode: Promise<number>;
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  stdin: WritableStream<Uint8Array>;
  kill(): void;
  exited: Promise<number>;
};

export type BunLike = {
  serve(options: {
    port: number;
    hostname: string;
    idleTimeout?: number;
    fetch(req: Request): Promise<Response> | Response;
  }): {
    stop(): void;
  };
  spawn(opts: {
    cmd: string[];
    cwd?: string;
    env?: Record<string, string>;
    stdin?: "pipe" | "ignore";
    stdout?: "pipe";
    stderr?: "pipe";
    timeout?: number;
  }): BunSpawnProc;
};

export function json<T>(body: T, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export async function readStream(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const buf = Buffer.concat(chunks);
  return buf.toString("utf-8");
}

/** Helper: spawn a command and return trimmed stdout, or empty string on error. */
export async function spawnRead(cmd: string[]): Promise<string> {
  try {
    const Bun = (globalThis as unknown as { Bun: BunLike }).Bun;
    const proc = Bun.spawn({ cmd, stdout: "pipe", stderr: "pipe" });
    const out = await readStream(proc.stdout);
    await proc.exited;
    return out.trim();
  } catch {
    return "";
  }
}
