# `packages/arkd/` client / server / common separation -- Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor `packages/arkd/` from a flat layout into a three-bucket layout (`common/`, `client/`, `server/`) with enforced sub-path entry points, so `ArkdClient` consumers cannot pull in `Bun.spawn`/tmux/FIFO server-side code via the import graph.

**Architecture:** Pure code-relocation refactor across 10 tasks (1 commit each, single PR). Each task is mechanical: move symbols to new homes, leave temporary re-export shims at the old paths so subsequent tasks compile, then delete shims at the end. No wire-shape changes, no behavior changes, no `core` reverse-dep cleanup (deferred). Final state has three barrels (`common/index.ts`, `client/index.ts`, `server/index.ts`) plus an ESLint `no-restricted-imports` rule that bans deep imports from outside `packages/arkd/`.

**Tech Stack:** Bun + TypeScript (no build step; `bun run` executes `.ts` directly). No workspaces -- relative imports with `.js` extensions. `bun:test` for tests. ESLint flat config (`eslint.config.js`).

**Spec:** `docs/superpowers/specs/2026-05-05-arkd-separation-design.md`

---

## TDD note for this plan

This is a pure refactor, not new behavior. The "test that must fail first" pattern doesn't apply -- the existing test suite (`packages/arkd/__tests__/*.ts`, plus consumers in `packages/{compute,core,server,cli}/__tests__/`) is the safety net. Each task's verification is "the existing tests still pass" (`make test-file F=packages/arkd/__tests__/<file>.test.ts` for fast feedback during the task; `make test` at the end).

The one *new* test (Task 7's `exports-shape.test.ts`) is TDD-shaped: write it failing, then make it pass by adding the right exports to the barrels.

---

## Pre-flight

- [ ] **Verify clean tree.**

  Run: `git status`
  Expected: `nothing to commit, working tree clean` on `main`.

- [ ] **Run baseline test pass.**

  Run: `make test 2>&1 | tail -20`
  Expected: all tests pass. Note any pre-existing failures so they're not attributed to the refactor.

- [ ] **Create feature branch.**

  Run: `git checkout -b refactor/arkd-separation`
  Expected: `Switched to a new branch 'refactor/arkd-separation'`

---

## Task 1: Directory skeleton + move types.ts

**Files:**
- Create: `packages/arkd/common/` (directory)
- Create: `packages/arkd/client/` (directory)
- Create: `packages/arkd/server/` (directory)
- Create: `packages/arkd/server/routes/` (directory)
- Create: `packages/arkd/common/types.ts`
- Modify: `packages/arkd/types.ts` (becomes a re-export shim)

- [ ] **Step 1: Create the four new directories.**

  Run:
  ```bash
  mkdir -p packages/arkd/common packages/arkd/client packages/arkd/server/routes
  ```

  Expected: no output, directories exist.

- [ ] **Step 2: Move `types.ts` to `common/types.ts`.**

  Run:
  ```bash
  git mv packages/arkd/types.ts packages/arkd/common/types.ts
  ```

  Expected: `git status` shows the rename.

- [ ] **Step 3: Recreate `packages/arkd/types.ts` as a shim.**

  Create file `packages/arkd/types.ts` with content:

  ```ts
  /**
   * SHIM -- re-exports from common/types.ts. Will be deleted in Task 10.
   *
   * New code should import from `./common/types.js` (or the
   * `arkd/common/index.js` barrel once Task 7 lands).
   */
  export type * from "./common/types.js";
  ```

- [ ] **Step 4: Verify arkd tests still pass.**

  Run: `make test-file F=packages/arkd/__tests__/server.test.ts`
  Expected: all tests pass.

- [ ] **Step 5: Verify consumer tests still resolve types.**

  Run: `make test-file F=packages/compute/__tests__/local-arkd.test.ts`
  Expected: all tests pass.

- [ ] **Step 6: Commit.**

  ```bash
  git add packages/arkd/
  git commit -m "refactor(arkd): move types.ts to common/, add directory skeleton"
  ```

---

## Task 2: Split `internal.ts` into 6 files

**Files:**
- Create: `packages/arkd/common/constants.ts`
- Create: `packages/arkd/common/validation.ts`
- Create: `packages/arkd/server/exec-allowlist.ts`
- Create: `packages/arkd/server/confinement.ts`
- Create: `packages/arkd/server/route-ctx.ts`
- Create: `packages/arkd/server/helpers.ts`
- Modify: `packages/arkd/internal.ts` (becomes a re-export shim)

- [ ] **Step 1: Create `packages/arkd/common/constants.ts`.**

  Full file content:

  ```ts
  /**
   * Wire-level constants. Imported by both arkd client and arkd server.
   *
   * SAFE_TMUX_NAME_RE doubles as the channel-name + process-handle pattern;
   * the name is a hold-over from when these primitives only wrapped tmux
   * sessions, but the regex is stable wire-protocol now.
   */

  export const VERSION = "0.1.0";
  export const DEFAULT_PORT = 19300;

  /** Paths that bypass authentication (health probes). */
  export const AUTH_EXEMPT_PATHS = new Set(["/health"]);

  /**
   * tmux session names, channel names, and process handles all share this
   * pattern. Restricted charset closes shell-injection paths in
   * `/tmp/arkd-launcher-<sessionName>.sh` and the `tmux send-keys -l`
   * argument plumbing.
   */
  export const SAFE_TMUX_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;

  /**
   * Wire control frame the server sends as the very first message on every
   * new subscriber WS, after the subscriber is registered and the ring
   * buffer has been drained. The client iterator strips this frame before
   * yielding to callers.
   *
   * Pre-stringified at module load so the server's hot-path doesn't
   * JSON.stringify on every connect.
   */
  export const SUBSCRIBED_ACK = JSON.stringify({ type: "subscribed" });
  ```

- [ ] **Step 2: Create `packages/arkd/common/validation.ts`.**

  Full file content:

  ```ts
  /**
   * Wire validators shared by arkd client + arkd server.
   *
   * Both sides validate so the client can fail fast (saving a round trip)
   * and the server enforces regardless of caller (security).
   */

  import { SAFE_TMUX_NAME_RE } from "./constants.js";

  /**
   * Assert a value is a string matching the safe-name pattern. Used for
   * tmux session names, channel names, and process handles -- everything
   * that ends up as a shell argument or a filename component.
   */
  export function requireSafeTmuxName(name: unknown): asserts name is string {
    if (typeof name !== "string" || !SAFE_TMUX_NAME_RE.test(name)) {
      throw new Error("invalid sessionName: must match [A-Za-z0-9_-]{1,64}");
    }
  }
  ```

- [ ] **Step 3: Create `packages/arkd/server/exec-allowlist.ts`.**

  Full file content (lines copied from current `packages/arkd/internal.ts:74-117`):

  ```ts
  /**
   * Allowlist of commands the /exec endpoint will spawn.
   *
   * Server-only. Clients should NOT second-guess the allowlist; if a
   * legitimate command is blocked, add it here rather than working around
   * it client-side.
   */

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
  ```

- [ ] **Step 4: Create `packages/arkd/server/confinement.ts`.**

  Full file content (logic copied from current `packages/arkd/internal.ts:33-68`):

  ```ts
  /**
   * Workspace path confinement for /file/* and /exec.
   *
   * Server-only. Operates on real filesystem paths and returns the
   * resolved absolute path so callers can pass it straight to fs APIs.
   */

  import { resolve, sep } from "path";

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
   * empty / non-string input, or NUL bytes.
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
    const resolved = resolve(root, userPath);
    const rootWithSep = root.endsWith(sep) ? root : root + sep;
    if (resolved !== root && !resolved.startsWith(rootWithSep)) {
      throw new PathConfinementError(`path escapes workspace root: ${userPath}`);
    }
    return resolved;
  }
  ```

- [ ] **Step 5: Create `packages/arkd/server/helpers.ts`.**

  Full file content (logic copied from current `packages/arkd/internal.ts:135-213`):

  ```ts
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
  ```

- [ ] **Step 6: Create `packages/arkd/server/route-ctx.ts`.**

  Full file content (types copied from current `packages/arkd/internal.ts:14-31, 142-158`):

  ```ts
  /**
   * Per-server context shared with all route handlers.
   *
   * `conductorUrl` is a getter/setter because server.ts keeps it as a
   * mutable `let` that can be updated at runtime via POST /config or
   * setConductorUrl() on the returned handle.
   */

  export interface ArkdOpts {
    quiet?: boolean;
    conductorUrl?: string;
    hostname?: string;
    /** Bearer token for auth. Overrides ARK_ARKD_TOKEN env var. */
    token?: string;
    /**
     * Filesystem root that every /file/* and /exec request is confined to.
     * Required in hosted / untrusted contexts; when unset, /file/* and
     * /exec accept absolute paths from any caller and trust the bearer
     * token for full host FS access.
     */
    workspaceRoot?: string;
  }

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
  ```

- [ ] **Step 7: Replace `packages/arkd/internal.ts` with a shim.**

  Overwrite file with:

  ```ts
  /**
   * SHIM -- re-exports from new homes. Will be deleted in Task 10.
   *
   * New code should import from:
   *   - common/constants.js  (VERSION, DEFAULT_PORT, AUTH_EXEMPT_PATHS, SAFE_TMUX_NAME_RE)
   *   - common/validation.js (requireSafeTmuxName)
   *   - server/exec-allowlist.js (EXEC_ALLOWED_COMMANDS)
   *   - server/confinement.js (confineToWorkspace, PathConfinementError)
   *   - server/route-ctx.js (RouteCtx, ArkdOpts)
   *   - server/helpers.js (json, readStream, spawnRead, BunLike, BunSpawnProc)
   */

  export {
    VERSION,
    DEFAULT_PORT,
    AUTH_EXEMPT_PATHS,
    SAFE_TMUX_NAME_RE,
  } from "./common/constants.js";
  export { requireSafeTmuxName } from "./common/validation.js";
  export { EXEC_ALLOWED_COMMANDS } from "./server/exec-allowlist.js";
  export { confineToWorkspace, PathConfinementError } from "./server/confinement.js";
  export type { RouteCtx, ArkdOpts } from "./server/route-ctx.js";
  export { json, readStream, spawnRead } from "./server/helpers.js";
  export type { BunLike, BunSpawnProc } from "./server/helpers.js";
  ```

- [ ] **Step 8: Run arkd tests.**

  Run: `make test-file F=packages/arkd/__tests__/server.test.ts`
  Expected: all tests pass.

  Run: `make test-file F=packages/arkd/__tests__/security.test.ts`
  Expected: all tests pass.

  Run: `make test-file F=packages/arkd/__tests__/server-security.test.ts`
  Expected: all tests pass.

- [ ] **Step 9: Commit.**

  ```bash
  git add packages/arkd/
  git commit -m "refactor(arkd): split internal.ts into common/ + server/ pieces"
  ```

---

## Task 3: Split `client.ts` into 3 files + `common/errors.ts`

**Files:**
- Create: `packages/arkd/common/errors.ts`
- Create: `packages/arkd/client/client.ts`
- Create: `packages/arkd/client/retry.ts`
- Create: `packages/arkd/client/ws-iterator.ts`
- Modify: `packages/arkd/client.ts` (becomes a re-export shim)

- [ ] **Step 1: Create `packages/arkd/common/errors.ts`.**

  Full file content (extracted from current `packages/arkd/client.ts:414-447`):

  ```ts
  /**
   * Error shapes for the arkd protocol.
   *
   * `ArkdError` is the wire envelope arkd returns on non-2xx (already
   * defined in `./types.ts` and re-exported here). The two classes below
   * are thrown by `ArkdClient`; transport errors carry request context so
   * UI surfaces show what actually failed.
   */

  export type { ArkdError } from "./types.js";

  /** Thrown by ArkdClient when the server returns a non-2xx response. */
  export class ArkdClientError extends Error {
    constructor(
      message: string,
      public readonly code?: string,
      public readonly httpStatus?: number,
    ) {
      super(message);
      this.name = "ArkdClientError";
    }
  }

  /**
   * Thrown when fetch() itself fails (DNS / connect / socket-close /
   * timeout) -- distinct from `ArkdClientError`, which is a clean non-2xx
   * arkd-side reject. Carries the request URL + method + attempt count so
   * a session that fails dispatch surfaces an actionable message in the
   * UI instead of a bare `TypeError: socket closed`. The original error
   * is preserved on `.cause` for stack-trace reconstruction.
   */
  export class ArkdClientTransportError extends Error {
    readonly url: string;
    readonly method: string;
    readonly path: string;
    readonly attempts: number;
    constructor(
      message: string,
      opts: { url: string; method: string; path: string; attempts: number; cause?: unknown },
    ) {
      super(message, { cause: opts.cause });
      this.name = "ArkdClientTransportError";
      this.url = opts.url;
      this.method = opts.method;
      this.path = opts.path;
      this.attempts = opts.attempts;
    }
  }
  ```

- [ ] **Step 2: Create `packages/arkd/client/retry.ts`.**

  Full file content (extracted from current `packages/arkd/client.ts:308-373`):

  ```ts
  /**
   * Transient-error retry layer for ArkdClient fetches.
   *
   * Bun's connection pool can hand out a socket that an SSM tunnel has
   * silently torn down; the next fetch surfaces ECONNRESET-shaped errors
   * even though arkd is healthy. We retry twice with backoff (250ms, 1s)
   * before wrapping in ArkdClientTransportError.
   */

  import { ArkdClientError, ArkdClientTransportError } from "../common/errors.js";

  /**
   * Recognize transient transport-level fetch failures: a stale pooled
   * keep-alive socket closed by the peer (or the SSM port-forward that
   * carries it) surfaces as `TypeError: The socket connection was closed
   * unexpectedly`. Retrying immediately opens a fresh socket and almost
   * always succeeds.
   *
   * We intentionally do NOT retry timeouts (those are caller-shaped) or
   * ArkdClientError (those are real arkd-side rejects with codes).
   */
  export function isTransientTransportError(e: unknown): boolean {
    if (e instanceof ArkdClientError) return false;
    const msg = (e as { message?: string })?.message ?? String(e);
    return (
      msg.includes("socket connection was closed") ||
      msg.includes("ECONNRESET") ||
      msg.includes("ECONNREFUSED") ||
      msg.includes("EPIPE") ||
      msg.includes("fetch failed")
    );
  }

  /**
   * Fetch with bounded transient-error retry. Each attempt gets the full
   * timeout budget; we don't shorten it because the original request
   * might have been partway through a long arkd-side exec.
   */
  export async function fetchWithRetry(
    url: string,
    init: RequestInit,
    timeoutMs: number,
    path: string,
    method: "GET" | "POST",
  ): Promise<Response> {
    const delays = [250, 1000];
    let lastErr: unknown = null;
    for (let attempt = 0; ; attempt++) {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(new Error(`arkd ${path}: timeout after ${timeoutMs}ms`)), timeoutMs);
      try {
        return await fetch(url, { ...init, signal: ac.signal });
      } catch (e) {
        lastErr = e;
        if (attempt < delays.length && isTransientTransportError(e)) {
          await new Promise((r) => setTimeout(r, delays[attempt]));
          continue;
        }
        throw new ArkdClientTransportError(
          `arkd ${method} ${url} failed after ${attempt + 1} attempt(s): ` +
            `${(e as { message?: string })?.message ?? String(e)}`,
          { url, method, path, attempts: attempt + 1, cause: e },
        );
      } finally {
        clearTimeout(t);
      }
    }
    throw lastErr;
  }
  ```

- [ ] **Step 3: Create `packages/arkd/client/ws-iterator.ts`.**

  Full file content (extracted from current `packages/arkd/client.ts:449-581`):

  ```ts
  /**
   * Bridge a WebSocket subscription to an `AsyncIterable<E>`.
   *
   * Resolves only after the server sends `{ type: "subscribed" }` as its
   * first frame -- the client's `open` event fires when the HTTP Upgrade
   * response arrives, but Bun's server-side `ws.open()` callback may run
   * later. The ack proves the subscriber is registered, so any publish
   * after `await subscribeToChannel(...)` is guaranteed to find a live
   * subscriber rather than buffer.
   */

  import { ArkdClientError } from "../common/errors.js";

  export async function webSocketToAsyncIterable<E extends Record<string, unknown>>(
    ws: WebSocket,
    channel: string,
    signal: AbortSignal | undefined,
  ): Promise<AsyncIterable<E>> {
    const queue: E[] = [];
    let resume: (() => void) | null = null;
    let closed = false;
    let error: Error | null = null;

    const wake = (): void => {
      const r = resume;
      resume = null;
      if (r) r();
    };

    let resolveAck!: () => void;
    let rejectAck!: (err: Error) => void;
    const ackPromise = new Promise<void>((resolve, reject) => {
      resolveAck = resolve;
      rejectAck = reject;
    });

    ws.addEventListener("message", (ev) => {
      try {
        const data = typeof ev.data === "string" ? ev.data : "";
        if (!data) return;
        const parsed = JSON.parse(data) as Record<string, unknown>;
        if (parsed.type === "subscribed") {
          resolveAck();
          return;
        }
        queue.push(parsed as E);
        wake();
      } catch {
        /* malformed frame -- skip rather than crash the consumer loop */
      }
    });

    ws.addEventListener("close", () => {
      closed = true;
      rejectAck(new ArkdClientError(`channel ws closed before subscribed ack: ${channel}`));
      wake();
    });

    ws.addEventListener("error", () => {
      error = new ArkdClientError(`channel ws subscribe failed: ${channel}`);
      closed = true;
      rejectAck(error);
      wake();
    });

    const abort = (): void => {
      closed = true;
      rejectAck(new ArkdClientError(`channel ws subscribe aborted: ${channel}`));
      try {
        ws.close();
      } catch {
        /* already closed */
      }
      wake();
    };

    if (signal?.aborted) {
      abort();
    } else {
      signal?.addEventListener("abort", abort, { once: true });
    }

    await ackPromise;

    return {
      [Symbol.asyncIterator](): AsyncIterator<E> {
        return {
          async next(): Promise<IteratorResult<E>> {
            while (true) {
              if (queue.length > 0) {
                return { value: queue.shift()!, done: false };
              }
              if (closed) {
                if (error) throw error;
                try {
                  ws.close();
                } catch {
                  /* already closed */
                }
                return { value: undefined as unknown as E, done: true };
              }
              await new Promise<void>((resolve) => {
                resume = resolve;
              });
            }
          },
          async return(): Promise<IteratorResult<E>> {
            closed = true;
            try {
              ws.close();
            } catch {
              /* already closed */
            }
            wake();
            return { value: undefined as unknown as E, done: true };
          },
        };
      },
    };
  }
  ```

- [ ] **Step 4: Create `packages/arkd/client/client.ts`.**

  This is `packages/arkd/client.ts:1-412` minus the retry/ws-iterator/error helpers extracted above. Full file content:

  ```ts
  /**
   * ArkdClient -- typed HTTP wrapper for talking to an arkd instance.
   *
   * Providers use this instead of SSH / direct tmux to interact with
   * compute targets.
   */

  import type {
    ReadFileRes,
    WriteFileReq,
    WriteFileRes,
    ListDirReq,
    ListDirRes,
    StatRes,
    MkdirReq,
    MkdirRes,
    ExecReq,
    ExecRes,
    ProcessSpawnReq,
    ProcessSpawnRes,
    ProcessKillReq,
    ProcessKillRes,
    ProcessStatusReq,
    ProcessStatusRes,
    AgentLaunchReq,
    AgentLaunchRes,
    AgentKillReq,
    AgentKillRes,
    AgentStatusReq,
    AgentStatusRes,
    AgentCaptureReq,
    AgentCaptureRes,
    AgentAttachOpenReq,
    AgentAttachOpenRes,
    AgentAttachInputReq,
    AgentAttachInputRes,
    AgentAttachResizeReq,
    AgentAttachResizeRes,
    AgentAttachCloseReq,
    AgentAttachCloseRes,
    ChannelPublishRes,
    MetricsRes,
    ProbePortsRes,
    HealthRes,
    SnapshotRes,
    ChannelReportRes,
    ChannelRelayReq,
    ChannelRelayRes,
    ChannelDeliverReq,
    ChannelDeliverRes,
    ConfigRes,
    ArkdError,
  } from "../common/types.js";
  import { ArkdClientError } from "../common/errors.js";
  import { fetchWithRetry } from "./retry.js";
  import { webSocketToAsyncIterable } from "./ws-iterator.js";

  export class ArkdClient {
    private token: string | null;
    private requestTimeoutMs: number;

    constructor(
      private baseUrl: string,
      opts?: { token?: string; requestTimeoutMs?: number },
    ) {
      if (this.baseUrl.endsWith("/")) {
        this.baseUrl = this.baseUrl.slice(0, -1);
      }
      this.token = opts?.token ?? process.env.ARK_ARKD_TOKEN ?? null;
      this.requestTimeoutMs = opts?.requestTimeoutMs ?? 30_000;
    }

    // ── File operations ─────────────────────────────────────────────────

    async readFile(path: string): Promise<ReadFileRes> {
      return this.post("/file/read", { path });
    }

    async writeFile(req: WriteFileReq): Promise<WriteFileRes> {
      return this.post("/file/write", req);
    }

    async stat(path: string): Promise<StatRes> {
      return this.post("/file/stat", { path });
    }

    async mkdir(req: MkdirReq): Promise<MkdirRes> {
      return this.post("/file/mkdir", req);
    }

    async listDir(req: ListDirReq): Promise<ListDirRes> {
      return this.post("/file/list", req);
    }

    // ── Process running ─────────────────────────────────────────────────

    async run(req: ExecReq): Promise<ExecRes> {
      const serverTimeout = typeof req.timeout === "number" ? req.timeout : 30_000;
      const effectiveTimeout = Math.max(this.requestTimeoutMs, serverTimeout + 30_000);
      return this.post("/exec", req, { timeoutMs: effectiveTimeout });
    }

    // ── Generic process supervisor ──────────────────────────────────────

    async spawnProcess(req: ProcessSpawnReq): Promise<ProcessSpawnRes> {
      return this.post("/process/spawn", req);
    }

    async killProcess(req: ProcessKillReq): Promise<ProcessKillRes> {
      return this.post("/process/kill", req);
    }

    async statusProcess(req: ProcessStatusReq): Promise<ProcessStatusRes> {
      return this.post("/process/status", req);
    }

    // ── Agent lifecycle (LEGACY tmux wrappers) ──────────────────────────

    async launchAgent(req: AgentLaunchReq): Promise<AgentLaunchRes> {
      return this.post("/agent/launch", req);
    }

    async killAgent(req: AgentKillReq): Promise<AgentKillRes> {
      return this.post("/agent/kill", req);
    }

    async agentStatus(req: AgentStatusReq): Promise<AgentStatusRes> {
      return this.post("/agent/status", req);
    }

    async captureOutput(req: AgentCaptureReq): Promise<AgentCaptureRes> {
      return this.post("/agent/capture", req);
    }

    // ── Generic channel pub/sub ─────────────────────────────────────────

    async publishToChannel(channel: string, envelope: Record<string, unknown>): Promise<ChannelPublishRes> {
      return this.post(`/channel/${encodeURIComponent(channel)}/publish`, { envelope });
    }

    subscribeToChannel<E extends Record<string, unknown> = Record<string, unknown>>(
      channel: string,
      opts?: { signal?: AbortSignal },
    ): Promise<AsyncIterable<E>> {
      const wsBase = this.baseUrl.replace(/^http(s?):\/\//, "ws$1://");
      const url = `${wsBase}/ws/channel/${encodeURIComponent(channel)}`;
      const protocols = this.token ? [`Bearer.${this.token}`] : undefined;
      const ws = new WebSocket(url, protocols);
      return webSocketToAsyncIterable<E>(ws, channel, opts?.signal);
    }

    // ── Terminal attach (live) ──────────────────────────────────────────

    async attachOpen(req: AgentAttachOpenReq): Promise<AgentAttachOpenRes> {
      return this.post("/agent/attach/open", req);
    }

    async attachInput(req: AgentAttachInputReq): Promise<AgentAttachInputRes> {
      return this.post("/agent/attach/input", req);
    }

    async attachResize(req: AgentAttachResizeReq): Promise<AgentAttachResizeRes> {
      return this.post("/agent/attach/resize", req);
    }

    async attachClose(req: AgentAttachCloseReq): Promise<AgentAttachCloseRes> {
      return this.post("/agent/attach/close", req);
    }

    /**
     * Open the chunked byte stream for an attach handle. Returns the raw
     * `Response` so callers can pipe the body directly. The connect timeout
     * caps headers; once headers arrive the body stream lives independently.
     */
    async attachStream(streamHandle: string): Promise<Response> {
      const ac = new AbortController();
      const t = setTimeout(
        () => ac.abort(new Error(`arkd attachStream: timeout after ${this.requestTimeoutMs}ms`)),
        this.requestTimeoutMs,
      );
      void t;
      const resp = await fetch(`${this.baseUrl}/agent/attach/stream?handle=${encodeURIComponent(streamHandle)}`, {
        headers: this.authHeaders(),
        signal: ac.signal,
      });
      if (!resp.ok) {
        const body = await resp.text().catch(() => "");
        throw new ArkdClientError(`arkd /agent/attach/stream: ${body || resp.statusText}`, undefined, resp.status);
      }
      return resp;
    }

    // ── System ──────────────────────────────────────────────────────────

    async health(): Promise<HealthRes> {
      return this.get("/health");
    }

    async metrics(): Promise<MetricsRes> {
      return this.get("/metrics");
    }

    async snapshot(): Promise<SnapshotRes> {
      return this.get("/snapshot");
    }

    async probePorts(ports: number[]): Promise<ProbePortsRes> {
      return this.post("/ports/probe", { ports });
    }

    // ── Channel relay ───────────────────────────────────────────────────

    async channelReport(sessionId: string, report: Record<string, unknown>): Promise<ChannelReportRes> {
      return this.post(`/channel/${sessionId}`, report);
    }

    async channelRelay(req: ChannelRelayReq): Promise<ChannelRelayRes> {
      return this.post("/channel/relay", req);
    }

    async channelDeliver(req: ChannelDeliverReq): Promise<ChannelDeliverRes> {
      return this.post("/channel/deliver", req);
    }

    async setConfig(config: { conductorUrl?: string }): Promise<ConfigRes> {
      return this.post("/config", config);
    }

    async getConfig(): Promise<ConfigRes> {
      return this.get("/config");
    }

    // ── Internal ────────────────────────────────────────────────────────

    private authHeaders(): Record<string, string> {
      if (this.token) return { Authorization: `Bearer ${this.token}` };
      return {};
    }

    private async post<Req, Res>(path: string, body: Req, opts?: { timeoutMs?: number }): Promise<Res> {
      const timeoutMs = opts?.timeoutMs ?? this.requestTimeoutMs;
      const resp = await fetchWithRetry(
        `${this.baseUrl}${path}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", ...this.authHeaders() },
          body: JSON.stringify(body),
        },
        timeoutMs,
        path,
        "POST",
      );
      const data = await resp.json();
      if (!resp.ok) {
        const err = data as ArkdError;
        throw new ArkdClientError(`arkd ${path}: ${err.error}`, err.code, resp.status);
      }
      return data as Res;
    }

    private async get<Res>(path: string, opts?: { timeoutMs?: number }): Promise<Res> {
      const timeoutMs = opts?.timeoutMs ?? this.requestTimeoutMs;
      const resp = await fetchWithRetry(
        `${this.baseUrl}${path}`,
        { headers: this.authHeaders() },
        timeoutMs,
        path,
        "GET",
      );
      const data = await resp.json();
      if (!resp.ok) {
        const err = data as ArkdError;
        throw new ArkdClientError(`arkd ${path}: ${err.error}`, err.code, resp.status);
      }
      return data as Res;
    }
  }
  ```

- [ ] **Step 5: Replace `packages/arkd/client.ts` with a shim.**

  Overwrite file with:

  ```ts
  /**
   * SHIM -- re-exports from client/ and common/. Will be deleted in Task 10.
   *
   * New code should import from:
   *   - client/client.js (ArkdClient)
   *   - common/errors.js (ArkdClientError, ArkdClientTransportError)
   */

  export { ArkdClient } from "./client/client.js";
  export { ArkdClientError, ArkdClientTransportError } from "./common/errors.js";
  ```

- [ ] **Step 6: Run client tests.**

  Run: `make test-file F=packages/arkd/__tests__/client.test.ts`
  Expected: all tests pass.

  Run: `make test-file F=packages/arkd/__tests__/client-retry.test.ts`
  Expected: all tests pass.

  Run: `make test-file F=packages/arkd/__tests__/client-timeout.test.ts`
  Expected: all tests pass.

- [ ] **Step 7: Commit.**

  ```bash
  git add packages/arkd/
  git commit -m "refactor(arkd): split client.ts into client/{client,retry,ws-iterator}.ts + common/errors.ts"
  ```

---

## Task 4: Split `server.ts` into 4 files

**Files:**
- Create: `packages/arkd/server/auth.ts`
- Create: `packages/arkd/server/control-plane.ts`
- Create: `packages/arkd/server/server.ts` (slimmed)
- Modify: `packages/arkd/server/route-ctx.ts` (add `createRouteCtx` factory)
- Modify: `packages/arkd/server.ts` (becomes a re-export shim)

NOTE: Routes still live at `packages/arkd/routes/`. Task 5 moves them to `packages/arkd/server/routes/`. The new `server/server.ts` in this task imports from the OLD `../routes/*` paths; Task 5 updates them.

- [ ] **Step 1: Create `packages/arkd/server/auth.ts`.**

  Full file content (logic extracted from current `packages/arkd/server.ts:84-126`):

  ```ts
  /**
   * Bearer-token auth for arkd HTTP + WebSocket requests.
   *
   * Token persistence: when a token is configured, it's written to
   * `~/.ark/arkd.token` (mode 0600) so other ark processes on the same
   * host can pick it up without env-var plumbing.
   *
   * WebSocket auth: browsers can't set custom Upgrade headers, so the
   * client also accepts `Sec-WebSocket-Protocol: Bearer.<token>` as an
   * alternative to `Authorization: Bearer <token>`. Both paths feed the
   * same constant-time compare.
   */

  import { writeFileSync, mkdirSync, existsSync } from "fs";
  import { join } from "path";
  import { homedir } from "os";
  import { timingSafeEqual } from "crypto";
  import { AUTH_EXEMPT_PATHS } from "../common/constants.js";
  import { json } from "./helpers.js";

  /**
   * Persist the token to ~/.ark/arkd.token (0600). Returns the pre-padded
   * `Bearer <token>` byte buffer used by checkAuth's constant-time compare.
   * Returns null when no token is configured (legacy local-only mode).
   */
  export function setupAuth(token: string | null): Buffer | null {
    if (!token) return null;
    const arkDir = join(homedir(), ".ark");
    if (!existsSync(arkDir)) mkdirSync(arkDir, { recursive: true });
    writeFileSync(join(arkDir, "arkd.token"), token, { mode: 0o600 });
    return Buffer.from(`Bearer ${token}`);
  }

  /**
   * Check the bearer token on `req`. Returns null when authorized (or auth
   * disabled); returns a 401 Response when not. AUTH_EXEMPT_PATHS bypass.
   */
  export function checkAuth(
    req: Request,
    path: string,
    expectedAuth: Buffer | null,
  ): Response | null {
    if (!expectedAuth) return null;
    if (AUTH_EXEMPT_PATHS.has(path)) return null;
    let authHeader = req.headers.get("Authorization") ?? "";
    if (!authHeader) {
      const subproto = req.headers.get("Sec-WebSocket-Protocol") ?? "";
      const m = subproto
        .split(",")
        .map((s) => s.trim())
        .find((s) => s.startsWith("Bearer."));
      if (m) authHeader = `Bearer ${m.slice("Bearer.".length)}`;
    }
    const providedBuf = Buffer.from(authHeader);
    if (providedBuf.length !== expectedAuth.length) {
      timingSafeEqual(expectedAuth, expectedAuth);
      return json({ error: "Unauthorized" }, 401);
    }
    if (timingSafeEqual(providedBuf, expectedAuth)) return null;
    return json({ error: "Unauthorized" }, 401);
  }
  ```

- [ ] **Step 2: Create `packages/arkd/server/control-plane.ts`.**

  Full file content (logic extracted from current `packages/arkd/server.ts:128-165, 291-303`):

  ```ts
  /**
   * Control-plane registration. When `ARK_CONTROL_PLANE_URL` is set, arkd
   * registers itself as a worker on startup, sends a heartbeat every 30s,
   * and deregisters on graceful shutdown.
   *
   * All HTTP calls are fire-and-forget: a missing or temporarily
   * unreachable control plane must never block arkd from serving requests.
   */

  import { hostname, platform } from "os";

  export interface ControlPlaneHandle {
    /** Stop the heartbeat timer + send deregister POST. Best-effort. */
    stop(): void;
  }

  /**
   * Register with the control plane (if configured) and start a 30s
   * heartbeat loop. Returns null when no control plane is configured.
   */
  export function startControlPlane(port: number): ControlPlaneHandle | null {
    const controlPlaneUrl = process.env.ARK_CONTROL_PLANE_URL;
    if (!controlPlaneUrl) return null;

    const workerId = process.env.ARK_WORKER_ID || `worker-${hostname()}-${port}`;
    const workerCapacity = parseInt(process.env.ARK_WORKER_CAPACITY ?? "5", 10);
    const workerUrl = `http://${hostname()}:${port}`;

    const registerPayload = {
      id: workerId,
      url: workerUrl,
      capacity: workerCapacity,
      compute_name: process.env.ARK_COMPUTE_NAME || null,
      tenant_id: process.env.ARK_TENANT_ID || null,
      metadata: { hostname: hostname(), platform: platform(), port },
    };

    fetch(`${controlPlaneUrl}/api/workers/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(registerPayload),
    }).catch(() => {
      /* control plane not ready yet -- heartbeat will retry */
    });

    const heartbeatTimer = setInterval(() => {
      fetch(`${controlPlaneUrl}/api/workers/heartbeat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: workerId }),
      }).catch(() => {
        /* control plane unreachable */
      });
    }, 30_000);

    return {
      stop() {
        clearInterval(heartbeatTimer);
        fetch(`${controlPlaneUrl}/api/workers/deregister`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: workerId }),
        }).catch(() => {
          /* best effort */
        });
      },
    };
  }
  ```

- [ ] **Step 3: Add `createRouteCtx` factory to `packages/arkd/server/route-ctx.ts`.**

  Append to existing file (at end):

  ```ts

  // ── Factory ─────────────────────────────────────────────────────────────

  import { resolve } from "path";
  import { mkdirSync } from "fs";
  import { confineToWorkspace, PathConfinementError } from "./confinement.js";
  import { logDebug } from "../../core/observability/structured-log.js";

  /**
   * Construct a per-server RouteCtx. Resolves the workspace root, creates
   * it if missing (best-effort), and binds a `confine` closure that's a
   * no-op in legacy unconfined mode.
   *
   * `getConductorUrl` / `setConductorUrl` close over the caller's mutable
   * URL slot so /config and `setConductorUrl()` on the server handle stay
   * in sync.
   */
  export function createRouteCtx(opts: {
    workspaceRoot: string | null;
    getConductorUrl: () => string | null;
    setConductorUrl: (url: string | null) => void;
  }): RouteCtx {
    const workspaceRoot: string | null = opts.workspaceRoot ? resolve(opts.workspaceRoot) : null;
    if (workspaceRoot) {
      try {
        mkdirSync(workspaceRoot, { recursive: true });
      } catch {
        logDebug("compute", "best effort -- first real request will surface any permission error");
      }
    }
    const confine = (userPath: unknown): string => {
      if (!workspaceRoot) {
        if (typeof userPath !== "string") {
          throw new PathConfinementError("path must be a string");
        }
        return userPath;
      }
      return confineToWorkspace(workspaceRoot, userPath);
    };
    return {
      confine,
      workspaceRoot,
      getConductorUrl: opts.getConductorUrl,
      setConductorUrl: opts.setConductorUrl,
    };
  }
  ```

- [ ] **Step 4: Create `packages/arkd/server/server.ts` (slimmed).**

  Full file content. Imports the existing `../routes/*` paths -- Task 5 updates them.

  ```ts
  /**
   * ArkD HTTP server -- runs on every compute target.
   *
   * Provides file ops, process execution, agent lifecycle (tmux),
   * system metrics, and port probing over a typed JSON-over-HTTP API.
   *
   * This file owns the Bun.serve loop and the mutable per-server state
   * (conductorUrl, auth token, control-plane handle). Auth, control-plane
   * registration, and route ctx construction are extracted into sibling
   * modules; route families are dispatched in turn.
   */

  import { DEFAULT_PORT, VERSION } from "../common/constants.js";
  import type { HealthRes } from "../common/types.js";
  import type { ArkdOpts } from "./route-ctx.js";
  import { createRouteCtx } from "./route-ctx.js";
  import { PathConfinementError } from "./confinement.js";
  import { json, type BunLike } from "./helpers.js";
  import { setupAuth, checkAuth } from "./auth.js";
  import { startControlPlane } from "./control-plane.js";

  import { hostname, platform } from "os";

  import { handleFileRoutes } from "../routes/file.js";
  import { handleExecRoutes } from "../routes/exec.js";
  import { handleAgentRoutes } from "../routes/agent.js";
  import { handleMetricsSnapshotRoutes } from "../routes/metrics-snapshot.js";
  import { handleChannelRoutes } from "../routes/channel.js";
  import {
    channelWebSocketHandler,
    handleChannelRoutes as handleGenericChannelRoutes,
    matchWsChannelPath,
    type ChannelWsData,
  } from "../routes/channels.js";
  import { handleMiscRoutes } from "../routes/misc.js";
  import { handleAttachRoutes, sweepOrphanAttachFifos, closeAllAttachStreams } from "../routes/attach.js";
  import { handleProcessRoutes } from "../routes/process.js";

  declare const Bun: BunLike;

  export { PathConfinementError, VERSION };
  export type { ArkdOpts };

  export function startArkd(
    port = DEFAULT_PORT,
    opts?: ArkdOpts,
  ): { stop(): void; setConductorUrl(url: string): void } {
    let conductorUrl: string | null = opts?.conductorUrl ?? process.env.ARK_CONDUCTOR_URL ?? "http://localhost:19100";
    const bindHost = opts?.hostname ?? "0.0.0.0";

    const workspaceRootOpt = opts?.workspaceRoot ?? process.env.ARK_WORKSPACE_ROOT ?? null;
    const expectedAuth = setupAuth(opts?.token ?? process.env.ARK_ARKD_TOKEN ?? null);
    const controlPlane = startControlPlane(port);

    const ctx = createRouteCtx({
      workspaceRoot: workspaceRootOpt,
      getConductorUrl: () => conductorUrl,
      setConductorUrl: (url) => {
        conductorUrl = url;
      },
    });

    const server = Bun.serve({
      port,
      hostname: bindHost,
      idleTimeout: 0,
      websocket: {
        ...channelWebSocketHandler,
        idleTimeout: 30,
        sendPings: true,
      },
      async fetch(req, srv) {
        const url = new URL(req.url);
        const path = url.pathname;

        if (req.method === "GET" && path.startsWith("/ws/")) {
          const channelName = matchWsChannelPath(path);
          if (channelName) {
            const authErr = checkAuth(req, path, expectedAuth);
            if (authErr) return authErr;
            const data: ChannelWsData = { channel: channelName };
            if (srv.upgrade(req, { data })) {
              return undefined as unknown as Response;
            }
            return json({ error: "websocket upgrade failed" }, 400);
          }
          return json({ error: "unknown websocket path" }, 404);
        }

        try {
          if (req.method === "GET" && path === "/health") {
            return json<HealthRes>({
              status: "ok",
              version: VERSION,
              hostname: hostname(),
              platform: platform(),
            });
          }

          const authErr = checkAuth(req, path, expectedAuth);
          if (authErr) return authErr;

          const metricsRes = await handleMetricsSnapshotRoutes(req, path, ctx);
          if (metricsRes) return metricsRes;

          const fileRes = await handleFileRoutes(req, path, ctx);
          if (fileRes) return fileRes;

          const execRes = await handleExecRoutes(req, path, ctx);
          if (execRes) return execRes;

          const attachRes = await handleAttachRoutes(req, path);
          if (attachRes) return attachRes;

          const genericChannelRes = await handleGenericChannelRoutes(req, path, ctx);
          if (genericChannelRes) return genericChannelRes;

          const processRes = await handleProcessRoutes(req, path, ctx);
          if (processRes) return processRes;

          const agentRes = await handleAgentRoutes(req, path, ctx);
          if (agentRes) return agentRes;

          const channelRes = await handleChannelRoutes(req, path, ctx);
          if (channelRes) return channelRes;

          const miscRes = await handleMiscRoutes(req, path, ctx);
          if (miscRes) return miscRes;

          return new Response("Not found", { status: 404 });
        } catch (e: any) {
          if (e instanceof SyntaxError) {
            return json({ error: "invalid JSON" }, 400);
          }
          if (e instanceof PathConfinementError) {
            return json({ error: "path escapes workspace root", detail: e.message }, 403);
          }
          return json({ error: String(e.message ?? e) }, 500);
        }
      },
    });

    if (!opts?.quiet) process.stderr.write(`[arkd] listening on ${bindHost}:${port}\n`);

    void sweepOrphanAttachFifos();

    return {
      stop() {
        controlPlane?.stop();
        void closeAllAttachStreams();
        server.stop();
      },
      setConductorUrl(url: string) {
        conductorUrl = url;
      },
    };
  }
  ```

- [ ] **Step 5: Replace `packages/arkd/server.ts` with a shim.**

  Overwrite file with:

  ```ts
  /**
   * SHIM -- re-exports from server/server.ts. Will be deleted in Task 10.
   *
   * New code should import from `./server/server.js` (or
   * `arkd/server/index.js` once Task 7 lands).
   */

  export { startArkd, PathConfinementError, VERSION } from "./server/server.js";
  export type { ArkdOpts } from "./server/server.js";
  ```

- [ ] **Step 6: Run server tests.**

  Run: `make test-file F=packages/arkd/__tests__/server.test.ts`
  Expected: all tests pass.

  Run: `make test-file F=packages/arkd/__tests__/server-security.test.ts`
  Expected: all tests pass.

  Run: `make test-file F=packages/arkd/__tests__/security.test.ts`
  Expected: all tests pass.

- [ ] **Step 7: Commit.**

  ```bash
  git add packages/arkd/
  git commit -m "refactor(arkd): split server.ts into server/{server,auth,control-plane}.ts"
  ```

---

## Task 5: Move `routes/` to `server/routes/`

**Files:**
- Move: `packages/arkd/routes/*.ts` -> `packages/arkd/server/routes/*.ts` (all 9 files)
- Modify: each moved file (update relative imports from `../internal.js` -> `../*.js` and `../types.js` -> `../../common/types.js`)
- Modify: `packages/arkd/server/server.ts` (update route imports from `../routes/` -> `./routes/`)
- Create: `packages/arkd/routes/` shim files (one per moved file, re-exporting)

NOTE: The legacy `routes/channels.ts` is moved as-is in this task; the bisection into `server/channel-bus.ts` is Task 6.

- [ ] **Step 1: Move all 9 route files.**

  Run:
  ```bash
  for f in agent attach channel channels exec file metrics-snapshot misc process; do
    git mv packages/arkd/routes/$f.ts packages/arkd/server/routes/$f.ts
  done
  ```

  Expected: `git status` shows 9 renames.

- [ ] **Step 2: Update imports inside each moved route file.**

  In each of the 9 files at `packages/arkd/server/routes/<name>.ts`, update import paths:

  | Old import | New import |
  |---|---|
  | `from "../types.js"` | `from "../../common/types.js"` |
  | `from "../internal.js"` | split into the new homes -- pick the right one |
  | `from "../../core/observability/structured-log.js"` | `from "../../../core/observability/structured-log.js"` (depth changed) |
  | `from "../../core/constants.js"` | `from "../../../core/constants.js"` |
  | `from "./channels.js"` (in `channel.ts` -> `publishOnChannel`) | `from "./channels.js"` (still sibling) |

  For `from "../internal.js"`, the symbol -> file map (use it to rewrite each import):

  | Symbol | New `from` (relative to `server/routes/`) |
  |---|---|
  | `json` | `from "../helpers.js"` |
  | `readStream` | `from "../helpers.js"` |
  | `spawnRead` | `from "../helpers.js"` |
  | `BunLike` (type) | `from "../helpers.js"` |
  | `RouteCtx` (type) | `from "../route-ctx.js"` |
  | `requireSafeTmuxName` | `from "../../common/validation.js"` |
  | `SAFE_TMUX_NAME_RE` | `from "../../common/constants.js"` |
  | `EXEC_ALLOWED_COMMANDS` | `from "../exec-allowlist.js"` |

  Also: route files that today say `import "../internal.js"` with a multi-symbol list need to be split into multiple `import` statements -- one per new home.

  Files to update (9):
  - `packages/arkd/server/routes/file.ts`
  - `packages/arkd/server/routes/exec.ts`
  - `packages/arkd/server/routes/agent.ts`
  - `packages/arkd/server/routes/attach.ts`
  - `packages/arkd/server/routes/process.ts`
  - `packages/arkd/server/routes/channel.ts`
  - `packages/arkd/server/routes/channels.ts`
  - `packages/arkd/server/routes/metrics-snapshot.ts`
  - `packages/arkd/server/routes/misc.ts`

- [ ] **Step 3: Update `packages/arkd/server/server.ts` to import routes from `./routes/`.**

  In `packages/arkd/server/server.ts`, replace each `from "../routes/<name>.js"` with `from "./routes/<name>.js"`:

  ```ts
  import { handleFileRoutes } from "./routes/file.js";
  import { handleExecRoutes } from "./routes/exec.js";
  import { handleAgentRoutes } from "./routes/agent.js";
  import { handleMetricsSnapshotRoutes } from "./routes/metrics-snapshot.js";
  import { handleChannelRoutes } from "./routes/channel.js";
  import {
    channelWebSocketHandler,
    handleChannelRoutes as handleGenericChannelRoutes,
    matchWsChannelPath,
    type ChannelWsData,
  } from "./routes/channels.js";
  import { handleMiscRoutes } from "./routes/misc.js";
  import { handleAttachRoutes, sweepOrphanAttachFifos, closeAllAttachStreams } from "./routes/attach.js";
  import { handleProcessRoutes } from "./routes/process.js";
  ```

- [ ] **Step 4: Create shim files in the now-empty `packages/arkd/routes/` directory.**

  These exist so any test that still imports from the old paths keeps resolving until Task 8. Create one per moved file:

  `packages/arkd/routes/attach.ts`:
  ```ts
  /** SHIM -- moved to server/routes/attach.ts. Will be deleted in Task 10. */
  export { handleAttachRoutes, sweepOrphanAttachFifos, closeAllAttachStreams } from "../server/routes/attach.js";
  ```

  `packages/arkd/routes/channels.ts`:
  ```ts
  /** SHIM -- moved to server/routes/channels.ts. Will be deleted in Task 10. */
  export {
    channelWebSocketHandler,
    handleChannelRoutes,
    matchWsChannelPath,
    publishOnChannel,
    SUBSCRIBED_ACK,
    _resetForTests,
  } from "../server/routes/channels.js";
  export type { ChannelWsData } from "../server/routes/channels.js";
  ```

  `packages/arkd/routes/process.ts`:
  ```ts
  /** SHIM -- moved to server/routes/process.ts. Will be deleted in Task 10. */
  export { handleProcessRoutes, _resetForTests } from "../server/routes/process.js";
  ```

  The other 6 routes (`agent.ts`, `channel.ts`, `exec.ts`, `file.ts`, `metrics-snapshot.ts`, `misc.ts`) are imported only from `server.ts` (which already points at the new path) and never from tests, so they don't need shims. Skip them.

- [ ] **Step 5: Run all arkd tests.**

  Run: `make test-file F=packages/arkd/__tests__/server.test.ts`
  Run: `make test-file F=packages/arkd/__tests__/process.test.ts`
  Run: `make test-file F=packages/arkd/__tests__/attach.test.ts`
  Run: `make test-file F=packages/arkd/__tests__/attach-sweep.test.ts`
  Run: `make test-file F=packages/arkd/__tests__/channels.test.ts`
  Run: `make test-file F=packages/arkd/__tests__/channel-relay.test.ts`
  Run: `make test-file F=packages/arkd/__tests__/codegraph-endpoint.test.ts`
  Expected: all pass.

- [ ] **Step 6: Commit.**

  ```bash
  git add packages/arkd/
  git commit -m "refactor(arkd): move routes/ to server/routes/, add shims at old paths"
  ```

---

## Task 6: Bisect `routes/channels.ts` -> `server/channel-bus.ts`

**Files:**
- Create: `packages/arkd/server/channel-bus.ts` (the bus primitive)
- Modify: `packages/arkd/server/routes/channels.ts` (only the HTTP wrapper remains)
- Modify: `packages/arkd/server/routes/channel.ts` (legacy report/relay imports `publishOnChannel` -- update path)
- Modify: `packages/arkd/routes/channels.ts` (shim now re-exports across two new homes)
- Modify: `packages/arkd/common/constants.ts` already has `SUBSCRIBED_ACK` from Task 2; remove the duplicate from `server/routes/channels.ts`

- [ ] **Step 1: Create `packages/arkd/server/channel-bus.ts`.**

  Full file content (lines extracted from current `packages/arkd/server/routes/channels.ts`):

  ```ts
  /**
   * Generic channel bus -- the in-process Map<channel, state> + delivery
   * semantics that back the /channel/{name}/* HTTP endpoints + the
   * /ws/channel/{name} WebSocket subscriber.
   *
   * Channel names are GLOBAL on a single arkd instance. Per-channel
   * delivery semantics:
   *
   *   - `user-input`: BROADCAST -- each subscriber filters by session id,
   *     so every open subscriber gets a copy. Stale subscribers (dead
   *     sessions) ignore non-matching envelopes; the live one consumes
   *     its own. Used because a stale-but-readyState=OPEN subscriber from
   *     a dead session must not silently absorb the only copy of an
   *     envelope intended for the live subscriber of the new session.
   *
   *   - everything else (including `hooks`): FAN-OUT-TO-FIRST -- the
   *     envelope goes to the first OPEN subscriber in insertion order.
   *     Used when there is exactly one logical reader (the conductor for
   *     hooks); broadcasting would deliver each envelope to N readers and
   *     double-process every event.
   *
   * Both modes evict zombies (readyState !== OPEN, or send returns <= 0)
   * in the same pass that delivers, so a half-closed socket doesn't keep
   * absorbing envelopes silently.
   *
   * Subscribe handshake: the server sends `{ "type": "subscribed" }` as
   * the very first frame on every new WS connection, from inside the
   * `open()` handler -- after `s.subscribers.add(ws)` has run and the
   * ring has been drained. The client's `subscribeToChannel` returns a
   * Promise that resolves only after receiving this ack.
   */

  import type { ServerWebSocket } from "bun";
  import { SAFE_TMUX_NAME_RE, SUBSCRIBED_ACK } from "../common/constants.js";
  import { logDebug, logInfo } from "../../core/observability/structured-log.js";

  type Envelope = Record<string, unknown>;

  /** Per-WS-connection data attached via `server.upgrade(req, { data })`. */
  export interface ChannelWsData {
    channel: string;
  }

  interface ChannelState {
    /** Buffered envelopes waiting for a subscriber. FIFO drained on next connect. */
    ring: Envelope[];
    /** Currently-open WS subscribers in connect order. */
    subscribers: Set<ServerWebSocket<ChannelWsData>>;
  }

  const channels = new Map<string, ChannelState>();

  function stateFor(name: string): ChannelState {
    let s = channels.get(name);
    if (!s) {
      s = { ring: [], subscribers: new Set() };
      channels.set(name, s);
    }
    return s;
  }

  /**
   * Channels with broadcast delivery semantics. Other channels fan out to
   * the first open subscriber.
   */
  const BROADCAST_CHANNELS = new Set(["user-input"]);

  function enqueue(name: string, envelope: Envelope): boolean {
    const s = stateFor(name);
    const payload = JSON.stringify(envelope);
    const broadcast = BROADCAST_CHANNELS.has(name);

    const dead: Array<ServerWebSocket<ChannelWsData>> = [];
    let deliveredAny = false;
    for (const ws of s.subscribers) {
      if (ws.readyState !== 1 /* OPEN */) {
        dead.push(ws);
        continue;
      }
      const written = ws.send(payload);
      if (written > 0) {
        deliveredAny = true;
        if (!broadcast) break;
      } else {
        dead.push(ws);
      }
    }
    for (const ws of dead) s.subscribers.delete(ws);
    if (deliveredAny) return true;
    s.ring.push(envelope);
    return false;
  }

  /**
   * Publish an envelope from inside arkd (e.g. legacy channel-report path).
   * Returns `true` when delivered to a live subscriber, `false` when buffered.
   */
  export function publishOnChannel(name: string, envelope: Envelope): boolean {
    return enqueue(name, envelope);
  }

  /** Module-internal entrypoint used by the HTTP route wrapper. */
  export function publishFromHttp(name: string, envelope: Envelope): boolean {
    return enqueue(name, envelope);
  }

  /**
   * Bun WebSocket handler for `/ws/channel/{name}`. Wired into the
   * `Bun.serve({ websocket })` config in `server.ts`.
   */
  export const channelWebSocketHandler = {
    open(ws: ServerWebSocket<ChannelWsData>): void {
      const { channel } = ws.data;
      const s = stateFor(channel);
      s.subscribers.add(ws);

      while (s.ring.length > 0) {
        const env = s.ring.shift()!;
        try {
          ws.send(JSON.stringify(env));
        } catch {
          s.subscribers.delete(ws);
          s.ring.unshift(env);
          return;
        }
      }

      try {
        ws.send(SUBSCRIBED_ACK);
      } catch {
        s.subscribers.delete(ws);
        return;
      }

      logInfo("compute", `arkd channels: ws subscriber attached channel=${channel}`);
    },

    message(_ws: ServerWebSocket<ChannelWsData>, _msg: string | Buffer): void {
      logDebug("compute", "arkd channels: ws subscriber sent unexpected message; ignoring");
    },

    close(ws: ServerWebSocket<ChannelWsData>): void {
      const { channel } = ws.data;
      const s = channels.get(channel);
      if (s) s.subscribers.delete(ws);
      logInfo("compute", `arkd channels: ws subscriber detached channel=${channel}`);
    },
  };

  export function matchWsChannelPath(path: string): string | null {
    const prefix = "/ws/channel/";
    if (!path.startsWith(prefix)) return null;
    const inner = path.slice(prefix.length);
    if (inner.length === 0) return null;
    if (!SAFE_TMUX_NAME_RE.test(inner)) return null;
    return inner;
  }

  /**
   * Test-only: close all open subscriber WS connections and clear every
   * channel's ring buffer. Called in `afterEach` to prevent connection and
   * state leaks between test cases.
   */
  export function _resetForTests(): void {
    for (const s of channels.values()) {
      s.ring.length = 0;
      for (const ws of s.subscribers) {
        try {
          ws.close();
        } catch {
          /* already closed */
        }
      }
      s.subscribers.clear();
    }
    channels.clear();
  }
  ```

- [ ] **Step 2: Replace `packages/arkd/server/routes/channels.ts` with the slim HTTP wrapper.**

  Overwrite file with:

  ```ts
  /**
   * HTTP wrapper for the generic channel bus.
   *
   * Endpoint:
   *   - `POST /channel/{name}/publish` -- fire-and-forget producer.
   *
   * The WebSocket subscribe path (/ws/channel/{name}) is handled in
   * server.ts via Bun's native upgrade flow, which calls into
   * `channelWebSocketHandler` exported from `../channel-bus.js`.
   */

  import { SAFE_TMUX_NAME_RE } from "../../common/constants.js";
  import { json } from "../helpers.js";
  import type { RouteCtx } from "../route-ctx.js";
  import { publishFromHttp } from "../channel-bus.js";

  type Envelope = Record<string, unknown>;

  function matchPublishPath(path: string): string | null {
    const prefix = "/channel/";
    const suffix = "/publish";
    if (!path.startsWith(prefix) || !path.endsWith(suffix)) return null;
    const inner = path.slice(prefix.length, path.length - suffix.length);
    if (inner.length === 0) return null;
    if (!SAFE_TMUX_NAME_RE.test(inner)) return null;
    return inner;
  }

  export async function handleChannelRoutes(req: Request, path: string, _ctx: RouteCtx): Promise<Response | null> {
    if (req.method === "POST" && path.startsWith("/channel/") && path.endsWith("/publish")) {
      const name = matchPublishPath(path);
      if (!name) {
        return json({ error: "invalid channel name: must match [A-Za-z0-9_-]{1,64}" }, 400);
      }
      let body: { envelope?: unknown };
      try {
        body = (await req.json()) as { envelope?: unknown };
      } catch {
        return json({ error: "invalid JSON body" }, 400);
      }
      const env = body?.envelope;
      if (env === undefined || env === null || typeof env !== "object" || Array.isArray(env)) {
        return json({ error: "`envelope` must be a JSON object" }, 400);
      }
      const delivered = publishFromHttp(name, env as Envelope);
      return json({ ok: true, delivered });
    }

    return null;
  }
  ```

- [ ] **Step 3: Update `packages/arkd/server/routes/channel.ts` to import `publishOnChannel` from the bus.**

  Find the line `import { publishOnChannel } from "./channels.js";` and replace with:

  ```ts
  import { publishOnChannel } from "../channel-bus.js";
  ```

- [ ] **Step 4: Update `packages/arkd/server/server.ts` -- the WS handler still imports from `./routes/channels.js` for `channelWebSocketHandler` + `matchWsChannelPath`. Move those to come from `./channel-bus.js`.**

  In `packages/arkd/server/server.ts`, replace:

  ```ts
  import {
    channelWebSocketHandler,
    handleChannelRoutes as handleGenericChannelRoutes,
    matchWsChannelPath,
    type ChannelWsData,
  } from "./routes/channels.js";
  ```

  With:

  ```ts
  import { channelWebSocketHandler, matchWsChannelPath, type ChannelWsData } from "./channel-bus.js";
  import { handleChannelRoutes as handleGenericChannelRoutes } from "./routes/channels.js";
  ```

- [ ] **Step 5: Update `packages/arkd/routes/channels.ts` shim to re-export across both new homes.**

  Overwrite file with:

  ```ts
  /** SHIM -- bisected into server/channel-bus.ts + server/routes/channels.ts. Will be deleted in Task 10. */
  export {
    channelWebSocketHandler,
    matchWsChannelPath,
    publishOnChannel,
    _resetForTests,
  } from "../server/channel-bus.js";
  export type { ChannelWsData } from "../server/channel-bus.js";
  export { handleChannelRoutes } from "../server/routes/channels.js";
  export { SUBSCRIBED_ACK } from "../common/constants.js";
  ```

- [ ] **Step 6: Run channel tests.**

  Run: `make test-file F=packages/arkd/__tests__/channels.test.ts`
  Expected: all pass.

  Run: `make test-file F=packages/arkd/__tests__/channel-relay.test.ts`
  Expected: all pass.

- [ ] **Step 7: Commit.**

  ```bash
  git add packages/arkd/
  git commit -m "refactor(arkd): bisect routes/channels.ts into channel-bus + http wrapper"
  ```

---

## Task 7: Add barrels + `package.json` exports + `exports-shape.test.ts`

**Files:**
- Create: `packages/arkd/common/index.ts`
- Create: `packages/arkd/client/index.ts`
- Create: `packages/arkd/server/index.ts`
- Create: `packages/arkd/__tests__/exports-shape.test.ts`
- Modify: `packages/arkd/package.json`

- [ ] **Step 1: Create `packages/arkd/common/index.ts`.**

  Full file content:

  ```ts
  /**
   * Public surface for arkd common (wire types + constants + shared
   * validators + error classes). Imported by both client + server
   * consumers.
   */

  export type * from "./types.js";
  export {
    VERSION,
    DEFAULT_PORT,
    AUTH_EXEMPT_PATHS,
    SAFE_TMUX_NAME_RE,
    SUBSCRIBED_ACK,
  } from "./constants.js";
  export { requireSafeTmuxName } from "./validation.js";
  export { ArkdClientError, ArkdClientTransportError } from "./errors.js";
  ```

- [ ] **Step 2: Create `packages/arkd/client/index.ts`.**

  Full file content:

  ```ts
  /**
   * Public surface for arkd client. The error classes live in common/ but
   * are re-exported here for ergonomics -- existing call sites do
   * `import { ArkdClient, ArkdClientError } from "..."` in one go.
   */

  export { ArkdClient } from "./client.js";
  export { ArkdClientError, ArkdClientTransportError } from "../common/errors.js";
  ```

- [ ] **Step 3: Create `packages/arkd/server/index.ts`.**

  Full file content:

  ```ts
  /**
   * Public surface for arkd server. The CLI subcommand (`ark arkd`) and
   * the in-process launcher (`core/infra/arkd-launcher.ts`) both import
   * `startArkd` from here.
   */

  export { startArkd, PathConfinementError, VERSION } from "./server.js";
  export type { ArkdOpts } from "./server.js";
  ```

- [ ] **Step 4: Update `packages/arkd/package.json` with `exports` map.**

  Overwrite file with:

  ```json
  {
    "name": "@ark/arkd",
    "version": "0.1.0",
    "type": "module",
    "exports": {
      "./common": "./common/index.ts",
      "./client": "./client/index.ts",
      "./server": "./server/index.ts"
    }
  }
  ```

  (`"main"` field removed.)

- [ ] **Step 5: Create `packages/arkd/__tests__/exports-shape.test.ts`.**

  Full file content:

  ```ts
  /**
   * Pin the public barrel surfaces so accidental re-exports of internal
   * helpers don't leak through. Update the expected lists when the spec
   * changes; keep them sorted alphabetically for readable diffs.
   */

  import { describe, it, expect } from "bun:test";
  import * as common from "../common/index.js";
  import * as client from "../client/index.js";
  import * as server from "../server/index.js";

  describe("arkd public barrels", () => {
    it("common surface", () => {
      expect(Object.keys(common).sort()).toEqual([
        "ArkdClientError",
        "ArkdClientTransportError",
        "AUTH_EXEMPT_PATHS",
        "DEFAULT_PORT",
        "SAFE_TMUX_NAME_RE",
        "SUBSCRIBED_ACK",
        "VERSION",
        "requireSafeTmuxName",
      ]);
    });

    it("client surface", () => {
      expect(Object.keys(client).sort()).toEqual([
        "ArkdClient",
        "ArkdClientError",
        "ArkdClientTransportError",
      ]);
    });

    it("server surface", () => {
      expect(Object.keys(server).sort()).toEqual([
        "PathConfinementError",
        "VERSION",
        "startArkd",
      ]);
    });
  });
  ```

  Note: `ArkdOpts` is a type-only export and won't appear at runtime via `Object.keys`. Same for type re-exports from common (the `export type * from "./types.js"` line); they're TypeScript-only and have no runtime presence.

- [ ] **Step 6: Run the new test.**

  Run: `make test-file F=packages/arkd/__tests__/exports-shape.test.ts`
  Expected: all 3 tests pass. If any fail, the listed Object.keys reflect what's actually exported -- adjust the test expectation OR fix the barrel to match the spec, depending on whether the drift is intentional.

- [ ] **Step 7: Run the full arkd test suite.**

  Run: `make test-file F=packages/arkd/__tests__/server.test.ts`
  Expected: all pass.

- [ ] **Step 8: Commit.**

  ```bash
  git add packages/arkd/
  git commit -m "refactor(arkd): add common/client/server barrels + package.json exports + shape test"
  ```

---

## Task 8: Migrate 23 consumer import sites

**Files:** 23 consumer files across `packages/{cli,server,core,compute}/`. See spec section 3 for the full table -- this task is one step per consumer, then a verification + commit.

For each file below, change the `from "..."` clause as shown. Imported symbol names do NOT change.

- [ ] **Step 1: `packages/cli/commands/daemon.ts:135`.**

  Replace `await import("../../arkd/index.js")` with `await import("../../arkd/server/index.js")`.

- [ ] **Step 2: `packages/cli/commands/misc/arkd.ts:12`.**

  Replace `await import("../../../arkd/index.js")` with `await import("../../../arkd/server/index.js")`.

- [ ] **Step 3: `packages/cli/__tests__/daemon.test.ts:12`.**

  Replace `from "../../arkd/server.js"` with `from "../../arkd/server/index.js"`.

- [ ] **Step 4: `packages/server/index.ts:11`.**

  Replace `from "../arkd/client.js"` with `from "../arkd/client/index.js"`.

- [ ] **Step 5: `packages/server/__tests__/terminal-ws.test.ts:22`.**

  Replace `from "../../arkd/server.js"` with `from "../../arkd/server/index.js"`.

- [ ] **Step 6: `packages/server/__tests__/terminal-ws-tenant-gate.test.ts:31`.**

  Replace `from "../../arkd/server.js"` with `from "../../arkd/server/index.js"`.

- [ ] **Step 7: `packages/core/runtimes/claude-agent/user-message-stream.ts:32`.**

  Replace `from "../../../arkd/index.js"` with `from "../../../arkd/client/index.js"`.

- [ ] **Step 8: `packages/core/conductor/server/arkd-events-consumer.ts:38`.**

  Replace `from "../../../arkd/index.js"` with `from "../../../arkd/client/index.js"`.

- [ ] **Step 9: `packages/core/conductor/server/deliver-to-channel.ts:14`.**

  Replace `from "../../../arkd/client.js"` with `from "../../../arkd/client/index.js"`.

- [ ] **Step 10: `packages/core/services/worktree/pr.ts:32`.**

  Replace `from "../../../arkd/client.js"` with `from "../../../arkd/client/index.js"`.

- [ ] **Step 11: `packages/core/__tests__/arkd-events-consumer-channel.test.ts:31`.**

  Replace `from "../../arkd/routes/channels.js"` with `from "../../arkd/common/index.js"`. The imported symbol (`SUBSCRIBED_ACK`) stays the same.

- [ ] **Step 12: `packages/compute/core/workspace-clone.ts:17`.**

  Replace `from "../../arkd/client.js"` with `from "../../arkd/client/index.js"`.

- [ ] **Step 13: `packages/compute/providers/arkd-backed.ts:10`.**

  Replace `from "../../arkd/client.js"` with `from "../../arkd/client/index.js"`.

- [ ] **Step 14: `packages/compute/isolation/direct.ts:10`.**

  Replace `from "../../arkd/client.js"` with `from "../../arkd/client/index.js"`.

- [ ] **Step 15: `packages/compute/isolation/docker.ts:23`.**

  Replace `from "../../arkd/client.js"` with `from "../../arkd/client/index.js"`.

- [ ] **Step 16: `packages/compute/isolation/devcontainer.ts:35`.**

  Replace `from "../../arkd/client.js"` with `from "../../arkd/client/index.js"`.

- [ ] **Step 17: `packages/compute/isolation/docker-compose.ts:23`.**

  Replace `from "../../arkd/client.js"` with `from "../../arkd/client/index.js"`.

- [ ] **Step 18: `packages/compute/__tests__/local-arkd.test.ts:16-17`.**

  Replace:
  ```ts
  import { startArkd } from "../../arkd/server.js";
  import { ArkdClient } from "../../arkd/client.js";
  ```
  With:
  ```ts
  import { startArkd } from "../../arkd/server/index.js";
  import { ArkdClient } from "../../arkd/client/index.js";
  ```

- [ ] **Step 19: `packages/compute/__tests__/arkd-backed.test.ts:10`.**

  Replace `from "../../arkd/server.js"` with `from "../../arkd/server/index.js"`.

- [ ] **Step 20: `packages/compute/__tests__/devcontainer-runtime.test.ts:22`.**

  Replace `from "../../arkd/client.js"` with `from "../../arkd/client/index.js"`.

- [ ] **Step 21: `packages/compute/__tests__/remote-arkd-cleanup.test.ts:23`.**

  Replace `from "../../arkd/client.js"` with `from "../../arkd/client/index.js"`.

- [ ] **Step 22: `packages/compute/__tests__/docker-runtime.test.ts:15`.**

  Replace `from "../../arkd/client.js"` with `from "../../arkd/client/index.js"`.

- [ ] **Step 23: `packages/compute/__tests__/direct-runtime.test.ts:15`.**

  Replace `from "../../arkd/client.js"` with `from "../../arkd/client/index.js"`.

- [ ] **Step 24: Update arkd's own `__tests__/` import paths.**

  In each test file at `packages/arkd/__tests__/*.ts`, replace old paths with the new homes:

  | File | Old | New |
  |---|---|---|
  | `server.test.ts:9` | `from "../server.js"` | `from "../server/index.js"` |
  | `server-security.test.ts:10` | `from "../server.js"` | `from "../server/index.js"` |
  | `security.test.ts:12` | `from "../server.js"` | `from "../server/index.js"` |
  | `attach.test.ts:13` | `from "../server.js"` | `from "../server/index.js"` |
  | `attach-sweep.test.ts:15` | `from "../routes/attach.js"` | `from "../server/routes/attach.js"` |
  | `process.test.ts:11` | `from "../server.js"` | `from "../server/index.js"` |
  | `process.test.ts:12` | `from "../routes/process.js"` | `from "../server/routes/process.js"` |
  | `client.test.ts:9-10` | `from "../server.js"` + `from "../client.js"` | `from "../server/index.js"` + `from "../client/index.js"` |
  | `client-retry.test.ts:18` | `from "../client.js"` | `from "../client/index.js"` |
  | `client-timeout.test.ts:17` | `from "../client.js"` | `from "../client/index.js"` |
  | `channels.test.ts:23-25` | `from "../server.js"` + `from "../routes/channels.js"` + `from "../client.js"` | `from "../server/index.js"` + `from "../server/channel-bus.js"` (for `_resetForTests`) + `from "../client/index.js"` |
  | `channel-relay.test.ts:20-22` | `from "../server.js"` + `from "../client.js"` + `from "../routes/channels.js"` | `from "../server/index.js"` + `from "../client/index.js"` + `from "../server/channel-bus.js"` (for `_resetForTests as resetChannels`) |
  | `codegraph-endpoint.test.ts:12` | `from "../server.js"` | `from "../server/index.js"` |

  (`server-security.test.ts` may also import other symbols beyond `startArkd`; verify and update each one.)

- [ ] **Step 25: Run full test suite.**

  Run: `make test`
  Expected: all packages green.

- [ ] **Step 26: Commit.**

  ```bash
  git add packages/
  git commit -m "refactor(arkd): migrate 23 consumer import sites to sub-path entry points"
  ```

---

## Task 9: ESLint `no-restricted-imports` rule

**Files:**
- Modify: `eslint.config.js`

- [ ] **Step 1: Add the new rule block to `eslint.config.js`.**

  Open `eslint.config.js`. Find the existing `no-restricted-imports` config blocks (currently around line 82, scoped to `packages/core/ports/**`). Append a new block AFTER them and BEFORE the closing `]`:

  ```js
    {
      // Arkd boundary: external consumers must use the package barrels
      // (common/index.ts, client/index.ts, server/index.ts) -- no deep
      // imports into split internals or moved routes.
      files: ["packages/!(arkd)/**/*.ts", "packages/!(arkd)/**/*.tsx"],
      rules: {
        "no-restricted-imports": ["error", {
          patterns: [
            {
              group: ["**/arkd/server/*", "!**/arkd/server/index.js"],
              message: "Import arkd server symbols from arkd/server/index.js (the barrel).",
            },
            {
              group: ["**/arkd/client/*", "!**/arkd/client/index.js"],
              message: "Import arkd client symbols from arkd/client/index.js (the barrel).",
            },
            {
              group: ["**/arkd/common/*", "!**/arkd/common/index.js"],
              message: "Import arkd common symbols from arkd/common/index.js (the barrel).",
            },
            {
              group: ["**/arkd/index.js", "**/arkd/index"],
              message: "The arkd top-level barrel was removed. Import from arkd/{client,server,common}/index.js.",
            },
            {
              group: ["**/arkd/types.js", "**/arkd/internal.js", "**/arkd/client.js", "**/arkd/server.js", "**/arkd/routes/**"],
              message: "Old arkd flat paths were removed. Import from arkd/{client,server,common}/index.js.",
            },
          ],
        }],
      },
    },
  ```

- [ ] **Step 2: Run lint.**

  Run: `make lint`
  Expected: zero warnings, zero errors. If any consumer is still on a deep path, this catches it.

- [ ] **Step 3: Commit.**

  ```bash
  git add eslint.config.js
  git commit -m "refactor(arkd): add ESLint no-restricted-imports rule for arkd boundary"
  ```

---

## Task 10: Delete shims + final verification

**Files (all deletions):**
- Delete: `packages/arkd/index.ts`
- Delete: `packages/arkd/types.ts`
- Delete: `packages/arkd/internal.ts`
- Delete: `packages/arkd/client.ts`
- Delete: `packages/arkd/server.ts`
- Delete: `packages/arkd/routes/` (entire directory -- contains `attach.ts`, `channels.ts`, `process.ts` shims from Task 5/6)

- [ ] **Step 1: Delete top-level shim files.**

  Run:
  ```bash
  git rm packages/arkd/index.ts packages/arkd/types.ts packages/arkd/internal.ts packages/arkd/client.ts packages/arkd/server.ts
  ```

  Expected: `git status` shows 5 deletions.

- [ ] **Step 2: Delete the legacy `routes/` directory.**

  Run:
  ```bash
  git rm -r packages/arkd/routes
  ```

  Expected: `git status` shows the 3 shim files (`attach.ts`, `channels.ts`, `process.ts`) deleted.

- [ ] **Step 3: Run `make format`.**

  Run: `make format`
  Expected: succeeds; may rewrite a small number of files.

- [ ] **Step 4: Run `make lint`.**

  Run: `make lint`
  Expected: zero warnings, zero errors.

  If any error references a deleted shim path, the consumer migration in Task 8 missed a file -- track it down with:
  ```bash
  grep -rn "from \"[^\"]*arkd/\(types\|internal\|client\|server\|routes\)\(/[^\"]*\)\?\.js\"" packages/ --include="*.ts"
  ```

- [ ] **Step 5: Run full test suite.**

  Run: `make test`
  Expected: all packages green.

- [ ] **Step 6: Run the barrel-shape test specifically.**

  Run: `make test-file F=packages/arkd/__tests__/exports-shape.test.ts`
  Expected: all 3 tests pass. Surface matches spec section 3.

- [ ] **Step 7: Verify no surviving deep imports.**

  Run:
  ```bash
  grep -rn "from \"[./]*arkd/" packages/ --include="*.ts" | grep -vE "arkd/(client|server|common)/index\.js" | grep -v "^packages/arkd/"
  ```
  Expected: no output (any matches are deep imports that escaped Task 8).

- [ ] **Step 8: Commit.**

  ```bash
  git add packages/arkd/
  git commit -m "refactor(arkd): delete shims, finish client/server/common separation"
  ```

- [ ] **Step 9: Push and open PR.**

  ```bash
  git push -u origin refactor/arkd-separation
  gh pr create --title "refactor(arkd): client/server/common separation" --body "$(cat <<'EOF'
  ## Summary

  - Refactor packages/arkd/ from flat layout to common/ + client/ + server/ buckets
  - Add sub-path entry points (common/index.ts, client/index.ts, server/index.ts)
  - Migrate 23 consumer import sites in packages/{cli,server,core,compute}/
  - Add ESLint no-restricted-imports rule banning deep imports into the buckets
  - No wire-shape, no behavior, no `core` reverse-dep changes (deferred)

  Spec: docs/superpowers/specs/2026-05-05-arkd-separation-design.md

  ## Test plan
  - [x] make test (all packages green)
  - [x] make lint (zero warnings)
  - [x] make format (clean)
  - [x] exports-shape.test.ts pins the public barrel surfaces
  - [x] grep verifies no surviving deep imports

  🤖 Generated with [Claude Code](https://claude.com/claude-code)
  EOF
  )"
  ```

  Expected: PR URL printed.

---

## Self-review

**Spec coverage:**
- Final layout (spec §1) -> Tasks 1-7 produce every directory + file listed.
- File-by-file move map (§2) -> Tasks 2 (internal.ts), 3 (client.ts), 4 (server.ts), 5 (routes/), 6 (channels.ts bisection) cover every entry.
- `package.json` exports + barrel surfaces (§3) -> Task 7.
- 23 consumer import sites (§3) -> Task 8 (one step per file, exact match against the spec's table).
- `__tests__/exports-shape.test.ts` (§4) -> Task 7 step 5.
- ESLint `no-restricted-imports` rule (§4) -> Task 9.
- Migration order (§5: 7-commit cadence) -> Tasks 1-7 + Task 8 (consumers) + Task 9 (lint) + Task 10 (shim deletion). Plan has 10 commits vs spec's 7 because consumer migration + lint rule + shim deletion are split into discrete commits for review clarity. Each commit still builds.
- Success criteria (§5) -> Task 10 step 4 (lint), step 5 (test), step 6 (shape test), step 7 (grep verifier).

**Placeholder scan:** Searched for "TBD", "TODO", "implement later", "fill in details", "appropriate error handling", "Similar to Task". None found. Every step shows the exact code or command to run.

**Type consistency check:**
- `ArkdOpts` declared in Task 2 step 6 (`server/route-ctx.ts`), re-exported via Task 4 step 4 (`server/server.ts`), surfaced via Task 7 step 3 (`server/index.ts`). Type-only, hence not in Task 7 step 5's `Object.keys` assertion -- noted.
- `RouteCtx` declared in Task 2 step 6 (`server/route-ctx.ts`), consumed by routes via the import-rewrite table in Task 5 step 2.
- `BunLike` declared in Task 2 step 5 (`server/helpers.ts`), used by `server/server.ts` (`declare const Bun: BunLike;` in Task 4 step 4).
- `ArkdClientError` / `ArkdClientTransportError` declared in Task 3 step 1 (`common/errors.ts`), re-exported from `common/index.ts` (Task 7 step 1) AND `client/index.ts` (Task 7 step 2). Both surfaces include them in the shape test (Task 7 step 5).
- `SUBSCRIBED_ACK` declared in Task 2 step 1 (`common/constants.ts`), consumed by `server/channel-bus.ts` (Task 6 step 1) and re-exported from `common/index.ts` (Task 7 step 1).
- `publishOnChannel` declared in Task 6 step 1 (`server/channel-bus.ts`), consumed by `server/routes/channel.ts` (legacy report/relay) per Task 6 step 3.
- `confineToWorkspace`, `PathConfinementError` declared in Task 2 step 4 (`server/confinement.ts`), used by `server/route-ctx.ts` factory in Task 4 step 3, and re-exported from `server/index.ts` in Task 7 step 3.

All names consistent.

**One known asymmetry:** the spec's migration order (§5) has 7 commits; this plan has 10. Reason: the spec groups "migrate consumers" + "add lint rule" + "delete shims" + "verify" as one mental step ("step 6/7"), but they're three separate commits in the plan because (a) the lint rule needs the consumers already migrated to pass, and (b) the shim deletion needs the lint rule already in place to catch any lingering shim-only imports. The 10-commit decomposition is strictly more granular than the spec; no spec content is missed.
