/**
 * Shared helpers for arkd route modules.
 *
 * All route handlers receive a RouteCtx with the per-server state + helpers
 * (auth check, path confinement, mutable conductor URL). The dispatcher in
 * server.ts constructs one RouteCtx per Bun.serve() instance.
 */

import { resolve, sep } from "path";

export const VERSION = "0.1.0";
export const DEFAULT_PORT = 19300;

export interface ArkdOpts {
  quiet?: boolean;
  conductorUrl?: string;
  hostname?: string;
  /** Bearer token for auth. Overrides ARK_ARKD_TOKEN env var. */
  token?: string;
  /**
   * Filesystem root that every /file/* and /exec request is confined to.
   * All paths in request bodies (and /exec cwd) must resolve to a
   * descendant of this directory. Overrides ARK_WORKSPACE_ROOT env var.
   *
   * Required in hosted / untrusted contexts; when unset, /file/* and
   * /exec accept absolute paths from any caller and trust the bearer
   * token for full host FS access -- acceptable only for local-single-user
   * mode, which is the historical behavior retained for backward compat.
   */
  workspaceRoot?: string;
}

export class PathConfinementError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "PathConfinementError";
  }
}

/**
 * Resolve a user-supplied path and verify it stays under `root`.
 *
 * `root` must be an absolute, canonical directory path. Throws when the
 * input tries to escape via `..`, absolute paths outside the root,
 * empty / non-string input, or symlink-style traversal tricks.
 *
 * NOTE: this is a string-level guard. It does not `realpath` the target
 * (the file may not yet exist). Symlink traversal is mitigated at the
 * caller by refusing to write through links, but the primary defense
 * against malicious requests is that every absolute path NOT starting
 * with `root` is rejected outright.
 */
export function confineToWorkspace(root: string, userPath: unknown): string {
  if (typeof userPath !== "string" || userPath.length === 0) {
    throw new PathConfinementError("path must be a non-empty string");
  }
  if (userPath.includes("\0")) {
    throw new PathConfinementError("path contains NUL byte");
  }
  // Resolve against the root for relative paths; absolute paths resolve
  // to themselves. In either case we then check the prefix.
  const resolved = resolve(root, userPath);
  const rootWithSep = root.endsWith(sep) ? root : root + sep;
  if (resolved !== root && !resolved.startsWith(rootWithSep)) {
    throw new PathConfinementError(`path escapes workspace root: ${userPath}`);
  }
  return resolved;
}

/** Paths that bypass authentication (health probes). */
export const AUTH_EXEMPT_PATHS = new Set(["/health"]);

/** Commands allowed by the /exec endpoint. */
export const EXEC_ALLOWED_COMMANDS = new Set([
  "git",
  "bun",
  "make",
  "npm",
  "npx",
  "node",
  "cat",
  "ls",
  "head",
  "tail",
  "grep",
  "find",
  "wc",
  "diff",
  "echo",
  "pwd",
  "mkdir",
  "cp",
  "mv",
  "rm",
  "touch",
  "chmod",
  "sh",
  "bash",
  "zsh",
  "tmux",
  "df",
  "ps",
  "pgrep",
  "top",
  "uptime",
  "sysctl",
  "vm_stat",
  "lsof",
  "ss",
  "docker",
  "devcontainer",
  "claude",
  "codex",
  "gemini",
  "goose",
  "codegraph",
]);

// tmux session names must be usable as a shell argument and a POSIX filename
// component. We restrict to a safe charset to close two injection surfaces:
//   1. The `/tmp/arkd-launcher-<sessionName>.sh` path -- without this guard,
//      an attacker can write `../../../../etc/cron.d/poison` or clobber
//      arbitrary files writable by the arkd user.
//   2. The tmux shell-command argument `bash <scriptPath>` -- tmux parses
//      the final argv as a shell command, so spaces / metacharacters in the
//      session name bleed into shell parsing.
export const SAFE_TMUX_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function requireSafeTmuxName(name: unknown): asserts name is string {
  if (typeof name !== "string" || !SAFE_TMUX_NAME_RE.test(name)) {
    throw new Error("invalid sessionName: must match [A-Za-z0-9_-]{1,64}");
  }
}

export function json<T>(body: T, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Per-server context shared with all route handlers.
 *
 * `conductorUrl` is a getter/setter because server.ts keeps it as a
 * mutable `let` that can be updated at runtime via POST /config or
 * setConductorUrl() on the returned handle.
 */
export interface RouteCtx {
  /** Confine a user-supplied path. No-op when workspaceRoot is unset. */
  confine(userPath: unknown): string;
  /** Current workspace root (null => unconfined legacy mode). */
  workspaceRoot: string | null;
  /** Current conductor URL (null when unset). */
  getConductorUrl(): string | null;
  /** Update conductor URL (used by POST /config). */
  setConductorUrl(url: string | null): void;
}

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
