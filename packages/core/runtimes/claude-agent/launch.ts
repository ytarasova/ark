#!/usr/bin/env bun
/**
 * Launch entry point for the agent-sdk runtime.
 *
 * Reads session context from ARK_* env vars, invokes the Anthropic Agent SDK
 * `query()` with session-scoped options, iterates SDKMessages, and writes each
 * verbatim to `<ARK_SESSION_DIR>/transcript.jsonl`. Exits 0 on successful result,
 * 1 on error result or abort.
 *
 * The `runAgentSdkLaunch` function is exported for unit testing with an
 * injected stream -- when `opts.stream` is provided it is used as-is and
 * the real SDK is never called.
 *
 * Each SDKMessage is also forwarded to the conductor's /hooks/status endpoint
 * in Claude-Code-shaped hook payloads so Ark's existing state-transition and
 * events-table path provides real-time observability.
 */

import { appendFileSync, mkdirSync, readFileSync, statSync } from "fs";
import { dirname, join } from "path";

function resolveClaudeExecutable(): string | undefined {
  const override = process.env.ARK_CLAUDE_EXECUTABLE_PATH;
  if (override) return override;
  try {
    const candidate = join(dirname(process.execPath), "claude");
    if (statSync(candidate).isFile()) return candidate;
  } catch {
    /* no vendored binary next to ark -- fall through */
  }
  return Bun.which("claude") ?? undefined;
}
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { startInterventionTail } from "./intervention-tail.js";
import { subscribeUserMessages } from "./user-message-stream.js";
import { createAskUserMcpServer } from "./mcp-ask-user.js";
import { createStageControlMcpServer } from "./mcp-stage-control.js";

/**
 * SDK user message shape accepted by the Anthropic Agent SDK when passing an
 * AsyncIterable as the `prompt` option.
 */
export type SDKUserMessage = {
  type: "user";
  message: { role: "user"; content: string | Array<{ type: "text"; text: string }> };
};

// ---------------------------------------------------------------------------
// PromptQueue -- AsyncIterable<SDKUserMessage> backed by a bounded queue.
// push() enqueues a message; close() signals the end of the sequence.
// ---------------------------------------------------------------------------

class PromptQueue implements AsyncIterable<SDKUserMessage> {
  private pending: SDKUserMessage[] = [];
  private resolvers: Array<(msg: IteratorResult<SDKUserMessage>) => void> = [];
  private closed = false;

  push(content: string): void {
    const msg: SDKUserMessage = { type: "user", message: { role: "user", content } };
    const resolver = this.resolvers.shift();
    if (resolver) resolver({ value: msg, done: false });
    else this.pending.push(msg);
  }

  /**
   * Number of buffered messages waiting to be drained. Used by the Stop hook
   * to decide whether end_turn is actually safe to stop on -- a non-zero
   * count means the SDK has unread user input it should process before
   * exiting.
   */
  pendingCount(): number {
    return this.pending.length;
  }

  /**
   * Detach all currently parked iterator resolvers by yielding `done: true`
   * to each one. Called between query attempts: the SDK's iterator from a
   * previous, now-aborted query may still hold a parked `next()` resolver
   * here, and any message we push next would be silently delivered to that
   * dead iterator. Yielding `done` lets it terminate cleanly so the
   * subsequent push lands in `pending[]` for the next attempt's iterator.
   * The queue itself remains open for further pushes.
   */
  detachIterators(): void {
    const r = this.resolvers;
    this.resolvers = [];
    for (const resolve of r) resolve({ value: undefined as any, done: true });
  }

  close(): void {
    this.closed = true;
    for (const r of this.resolvers) r({ value: undefined as any, done: true });
    this.resolvers = [];
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        if (this.pending.length > 0) return Promise.resolve({ value: this.pending.shift()!, done: false });
        if (this.closed) return Promise.resolve({ value: undefined as any, done: true });
        return new Promise((resolve) => this.resolvers.push(resolve));
      },
    };
  }
}

export interface RunAgentSdkLaunchOpts {
  sessionId: string;
  sessionDir: string;
  worktree: string;
  promptFile: string;
  /** Optional model override (e.g. "claude-sonnet-4-6"). */
  model?: string;
  /** Maximum conversation turns. */
  maxTurns?: number;
  /** Per-query USD budget gate. */
  maxBudgetUsd?: number;
  /** Text appended to the claude_code preset system prompt. */
  systemAppend?: string;
  /**
   * Injection point for tests. When provided this iterable is iterated
   * instead of calling the real SDK `query()`. The real query() is imported
   * lazily so tests that inject a stream never load the SDK binary.
   * The prompt queue is bypassed entirely -- the injected stream is used as-is.
   */
  stream?: AsyncIterable<unknown>;
  /**
   * Alternative injection point for tests that need to drive the prompt queue
   * and optionally the resume flow. When provided, `streamFactory(queue, options)`
   * is called each iteration with the PromptQueue and the current SDK options
   * (which includes `resume` on iterations after an interrupt). Ignored when
   * `stream` is set.
   */
  streamFactory?: (prompt: AsyncIterable<SDKUserMessage>, options: Record<string, unknown>) => AsyncIterable<unknown>;
  /**
   * Fully-resolved hook endpoint URL. In production, `main()` selects:
   *   - `${ARK_ARKD_URL}/channel/hooks/publish` when arkd is reachable
   *     (remote dispatch on EC2/k8s -- arkd buffers + the conductor
   *     subscribes via /channel/hooks/subscribe)
   *   - `${ARK_CONDUCTOR_URL}/hooks/status` when the agent runs on the
   *     same host as the conductor (local dispatch)
   *
   * Undefined disables hook forwarding entirely (test fixtures).
   */
  hookEndpoint?: string;
  /**
   * Stage name this runtime instance was launched for. Stamped onto every
   * forwarded hook so the conductor's event log carries authoritative
   * per-stage attribution. Read from `ARK_STAGE` in `main()` -- the
   * launcher writes it from the dispatch context. Empty / missing value
   * is harmless (the conductor falls back to session.stage at log time)
   * but means historical events can be re-stamped if session.stage flaps.
   */
  stage?: string;
  /**
   * Optional bearer token for the conductor's Authorization header.
   * When set, every hook POST includes "Authorization: Bearer <token>".
   * In production, read from ARK_API_TOKEN env var.
   */
  authToken?: string;
  /**
   * Fetch implementation. Defaults to the global fetch. Injected in tests
   * so no real HTTP connections are made.
   */
  fetchFn?: typeof fetch;
}

export interface RunAgentSdkLaunchResult {
  exitCode: number;
  sawResult: boolean;
  /**
   * Reason text passed by the agent's `complete_stage` tool call (if any).
   * Surfaces in conductor events so the UI can show "Stage complete: <why>".
   */
  stageCompleteReason?: string;
}

// ---------------------------------------------------------------------------
// Hook forwarding -- A3b
// ---------------------------------------------------------------------------

/**
 * Map one SDKMessage to 0..N conductor hook payloads.
 *
 * Mapping table (see A3b task spec):
 *   system/init            -> SessionStart
 *   assistant (tool_use)   -> PreToolUse (one per tool_use block)
 *   user (tool_result)     -> PostToolUse (one per tool_result block)
 *   result/success         -> Stop
 *   result/error           -> Stop (with error details)
 *   everything else        -> (empty -- skipped)
 *
 * Every payload carries `session_id: arkSessionId` so the conductor's stale-
 * session guard resolves correctly. For agent-sdk sessions the Ark session
 * has no `claude_session_id`, so the guard's middle clause short-circuits and
 * all our hooks pass through.
 */
export function messageToHooks(
  msg: unknown,
  arkSessionId: string,
  stage?: string | null,
): Array<Record<string, unknown>> {
  const m = msg as Record<string, unknown>;
  const type = m.type as string | undefined;
  // Each runtime stamps its own stage label on every hook it emits. The
  // conductor uses this as the source of truth instead of reading
  // session.stage at log time -- the latter flaps when the state machine
  // advances mid-flight (e.g. status-poller -> mediate -> stage advance
  // while this same agent is still running) and would re-stamp the
  // agent's hooks with whichever stage happens to be current at write
  // time. Empty string means "I am the legacy launcher and don't know my
  // stage" -- the conductor treats absent and empty the same.
  const stageField: Record<string, unknown> = stage ? { stage } : {};

  if (type === "system" && (m.subtype as string | undefined) === "init") {
    return [
      {
        hook_event_name: "SessionStart",
        session_id: arkSessionId,
        cwd: m.cwd,
        tools: m.tools,
        model: m.model,
        mcp_servers: m.mcp_servers,
        permissionMode: m.permissionMode,
        ...stageField,
      },
    ];
  }

  if (type === "assistant") {
    const message = m.message as Record<string, unknown> | undefined;
    const content = (message?.content ?? []) as Array<Record<string, unknown>>;
    const hooks: Array<Record<string, unknown>> = [];
    for (const block of content) {
      const blockType = block.type as string | undefined;
      if (blockType === "tool_use") {
        hooks.push({
          hook_event_name: "PreToolUse",
          session_id: arkSessionId,
          tool_name: block.name,
          tool_input: block.input,
          tool_use_id: block.id,
          ...stageField,
        });
      } else if (blockType === "text") {
        // The model's narration between tool calls. Without this hook the
        // UI sees only PreToolUse / PostToolUse events and the user can't
        // tell what the agent is doing or planning -- just a stream of
        // bash/edit/read with no human-readable thread. Emit each text
        // block as a separate hook so the timeline can render them inline
        // alongside tool blocks.
        const text = typeof block.text === "string" ? block.text : "";
        if (text.trim().length > 0) {
          hooks.push({
            hook_event_name: "AgentMessage",
            session_id: arkSessionId,
            text,
            ...stageField,
          });
        }
      } else if (blockType === "thinking") {
        // Extended-thinking blocks (when enabled). The text lives on
        // `block.thinking`. Same rendering as "text" but tagged so the UI
        // can dim it / collapse it differently.
        const text = typeof block.thinking === "string" ? block.thinking : "";
        if (text.trim().length > 0) {
          hooks.push({
            hook_event_name: "AgentMessage",
            session_id: arkSessionId,
            text,
            thinking: true,
            ...stageField,
          });
        }
      }
    }
    return hooks;
  }

  if (type === "user") {
    const message = m.message as Record<string, unknown> | undefined;
    const content = (message?.content ?? []) as Array<Record<string, unknown>>;
    const hooks: Array<Record<string, unknown>> = [];
    for (const block of content) {
      if ((block.type as string | undefined) === "tool_result") {
        const rawContent = block.content;
        const toolResultContent =
          typeof rawContent === "string" ? rawContent : rawContent != null ? JSON.stringify(rawContent) : undefined;
        hooks.push({
          hook_event_name: "PostToolUse",
          session_id: arkSessionId,
          tool_use_id: block.tool_use_id,
          tool_result_content: toolResultContent,
          is_error: block.is_error ?? false,
          ...stageField,
        });
      }
    }
    return hooks;
  }

  if (type === "result") {
    const costFields: Record<string, unknown> = {
      session_id: arkSessionId,
      total_cost_usd: m.total_cost_usd,
      usage: m.usage,
      num_turns: m.num_turns,
      duration_ms: m.duration_ms,
      stop_reason: m.stop_reason,
      ...stageField,
    };

    const stop: Record<string, unknown> = { hook_event_name: "Stop", ...costFields };
    if (m.is_error) {
      stop.is_error = true;
      stop.subtype = m.subtype;
      stop.error = m.error;
      stop.errors = m.errors;
    }

    // Emit a second hook that drives the conductor state transition.
    // Stop alone is not in statusMap, so sessions would stay "running" forever
    // without SessionEnd or StopFailure following it.
    const transitionHook: Record<string, unknown> = { ...costFields };
    if (m.is_error) {
      transitionHook.hook_event_name = "StopFailure";
      transitionHook.error = m.error ?? String((m.errors as unknown[])?.[0] ?? "agent error");
      transitionHook.subtype = m.subtype;
      transitionHook.errors = m.errors;
    } else {
      transitionHook.hook_event_name = "SessionEnd";
    }

    return [stop, transitionHook];
  }

  if (type === "system" && (m.subtype as string | undefined) === "compact_boundary") {
    const meta = (m.compact_metadata ?? {}) as Record<string, unknown>;
    return [
      {
        hook_event_name: "Notification",
        session_id: arkSessionId,
        notification_type: "compaction",
        trigger: meta.trigger,
        pre_tokens: meta.pre_tokens,
        ts: Date.now(),
      },
    ];
  }

  // stream_event, assistant-text-only, and anything else: skip
  return [];
}

interface ForwardDeps {
  /**
   * Fully-resolved hook endpoint URL. Set by `main()` to either
   * `${ARK_ARKD_URL}/channel/hooks/publish` (remote dispatch -- the local
   * arkd's hooks channel buffers; conductor drains via subscribe) or
   * `${ARK_CONDUCTOR_URL}/hooks/status` (local dispatch -- direct to the
   * conductor). Undefined when neither env var is set -- forwarding is
   * then disabled.
   */
  hookEndpoint: string | undefined;
  arkSessionId: string;
  /** Stage name this runtime instance was launched for. Stamped onto every
   *  forwarded hook so the conductor's event log carries authoritative
   *  per-stage attribution instead of re-deriving it from session.stage at
   *  log time (#435 root cause #3). */
  stage?: string | null;
  authToken?: string;
  fetchFn?: typeof fetch;
}

/**
 * Forward one SDKMessage to the appropriate hook endpoint.
 *
 * Two modes:
 *   - LOCAL dispatch: post to `${conductorUrl}/hooks/status` -- direct to
 *     the conductor since the agent runs on the same host. Body is the raw
 *     hook payload; session id is in the query string.
 *   - REMOTE dispatch (EC2/k8s): publish on the local arkd's `hooks`
 *     channel via `${arkdUrl}/channel/hooks/publish`. Body wraps the hook
 *     in `{ envelope: { kind: "hook", session, query, body } }`; the
 *     conductor's hooks-channel subscriber dispatches by `kind`. There is
 *     no reverse network path from the worker to the conductor in pure-SSM
 *     mode, so the channel queue is the only conductor-reachable path.
 *
 * `deps.hookEndpoint` is the fully-resolved URL (computed in main() based
 * on which env var is set: ARK_ARKD_URL wins for remote, falls back to
 * ARK_CONDUCTOR_URL for local).
 *
 * Each forward is awaited serially to preserve event order. Any network
 * error is logged to stderr but never propagates -- an outage must not
 * break the agent loop. The transcript.jsonl remains the source of truth.
 */
async function forwardToConductor(message: unknown, deps: ForwardDeps): Promise<void> {
  if (!deps.hookEndpoint) return;
  const hooks = messageToHooks(message, deps.arkSessionId, deps.stage ?? null);
  const doFetch = deps.fetchFn ?? fetch;
  // Detect the arkd channel-publish path so we wrap the hook body in the
  // generic envelope. Any other URL (e.g. the legacy conductor /hooks/status)
  // gets the raw body + session query string.
  const isChannelPublish = deps.hookEndpoint.endsWith("/channel/hooks/publish");
  for (const hook of hooks) {
    try {
      if (isChannelPublish) {
        await doFetch(deps.hookEndpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(deps.authToken ? { Authorization: `Bearer ${deps.authToken}` } : {}),
          },
          body: JSON.stringify({
            envelope: {
              kind: "hook",
              session: deps.arkSessionId,
              query: `session=${encodeURIComponent(deps.arkSessionId)}`,
              body: hook,
              ts: new Date().toISOString(),
            },
          }),
        });
      } else {
        await doFetch(`${deps.hookEndpoint}?session=${encodeURIComponent(deps.arkSessionId)}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(deps.authToken ? { Authorization: `Bearer ${deps.authToken}` } : {}),
          },
          body: JSON.stringify(hook),
        });
      }
    } catch (err) {
      const msg = (err as Error)?.message ?? String(err);
      console.error(`[agent-sdk launch] hook forward failed: ${msg}`);
    }
  }
}

// ---------------------------------------------------------------------------

/**
 * Parse an environment variable as a finite number.
 * Returns undefined if the variable is absent, empty, or not a finite number.
 * Logs to stderr when a value is present but invalid.
 */
function optionalNumber(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    console.error(`[agent-sdk launch] invalid ${name}=${raw}, ignoring`);
    return undefined;
  }
  return n;
}

type StreamOutcome = "completed" | "interrupted" | "aborted";

interface DrainResult {
  outcome: StreamOutcome;
  sawResult: boolean;
  exitCode: number;
  /** SDK session ID captured from the first `system/init` message. */
  sdkSessionId?: string;
}

/**
 * Drain a message stream: write each message to transcript.jsonl, forward
 * hook payloads to the conductor, and return exit metadata plus the SDK
 * session ID captured from the first `system/init` message.
 *
 * Returns `outcome: "interrupted"` when the abort controller fires due to a
 * control-interrupt signal (written via `session/interrupt`). The caller's
 * outer loop uses this to resume with `options.resume = sdkSessionId`.
 *
 * Returns `outcome: "aborted"` for SIGTERM/SIGINT aborts or unhandled errors.
 * Returns `outcome: "completed"` when a `result` message arrives normally.
 *
 * When `originalPrompt` and `promptQueue` are provided, a `compact_boundary`
 * message causes the original prompt to be re-fed into the queue as a fresh
 * user message so the agent re-anchors on the task after compaction.
 */
async function drainStream(
  stream: AsyncIterable<unknown>,
  writeLine: (obj: unknown) => void,
  forwardDeps: ForwardDeps,
  signal?: AbortSignal,
  interruptFlag?: { fired: boolean },
  originalPrompt?: string,
  promptQueue?: PromptQueue,
): Promise<DrainResult> {
  let sawResult = false;
  let exitCode = 0;
  let sdkSessionId: string | undefined;
  let outcome: StreamOutcome = "completed";

  try {
    for await (const message of stream) {
      // Capture SDK session ID from the first system/init message.
      const m = message as Record<string, unknown>;
      if (m.type === "system" && (m.subtype as string | undefined) === "init" && !sdkSessionId) {
        sdkSessionId = m.session_id as string | undefined;
      }

      const msg = message as {
        type?: string;
        subtype?: string;
        is_error?: boolean;
        terminal_reason?: string;
      };

      // Detect the synthetic result message the SDK emits in response to
      // query.interrupt(): subtype=error_during_execution + is_error=true
      // + terminal_reason=aborted_streaming. This is NOT a real failure --
      // the launcher's outer loop will resume on the next iteration with
      // the queued user message. Don't propagate it to the conductor as a
      // failure event (which would trigger session-failure handling and
      // race the resume).
      const isInterruptResult =
        msg.type === "result" &&
        interruptFlag?.fired === true &&
        (msg.subtype === "error_during_execution" || msg.terminal_reason === "aborted_streaming");

      writeLine(message);
      if (!isInterruptResult) {
        await forwardToConductor(message, forwardDeps);
      }

      // Re-feed the original prompt after compaction so the agent stays on task.
      if (m.type === "system" && (m.subtype as string | undefined) === "compact_boundary") {
        if (originalPrompt !== undefined && promptQueue !== undefined) {
          const reminder =
            `[Compaction occurred. Original task preserved below to keep you on track.]\n\n` +
            `${originalPrompt}\n\n` +
            `[End of original task. Continue from where you left off.]`;
          promptQueue.push(reminder);
        }
      }

      if (msg.type === "result") {
        sawResult = true;
        if (isInterruptResult) {
          // Interrupt-induced: treat as a clean interrupt, not a failure.
          // Outer loop will see outcome="interrupted" and resume.
          outcome = "interrupted";
          return { outcome, sawResult, exitCode: 0, sdkSessionId };
        }
        if (msg.is_error) exitCode = 1;
        // Streaming-input mode keeps the SDK iterator open after `result`
        // waiting for the next user message in the queue. Break out so the
        // process can exit -- if a caller wants the agent to handle another
        // turn, they start a new session or push a message and re-enter via
        // session/inject (which spawns a new query() call upstream).
        break;
      }
    }
  } catch (err: unknown) {
    // When the abort fires (SIGTERM, SIGINT, or interrupt signal), the SDK
    // iterator throws with AbortError or similar. Check the interrupt flag to
    // distinguish a user-requested interrupt from a hard abort.
    if (interruptFlag?.fired) {
      outcome = "interrupted";
      // Do not write an error line -- the session continues in the next turn.
      return { outcome, sawResult, exitCode: 0, sdkSessionId };
    }
    if (signal?.aborted) {
      outcome = "aborted";
      // Do not write an error line -- caller decided to abort, not an agent failure.
      return { outcome, sawResult, exitCode: 1, sdkSessionId };
    }
    const e = err as { message?: string } | null;
    writeLine({ type: "error", source: "launch", message: String(e?.message ?? err) });
    exitCode = 1;
  }

  if (!sawResult && exitCode === 0 && outcome === "completed") {
    writeLine({ type: "error", source: "launch", message: "stream ended without result message" });
    exitCode = 1;
  }

  return { outcome, sawResult, exitCode, sdkSessionId };
}

// Maximum number of interrupt-resume cycles before giving up.
const MAX_INTERRUPTS = 20;

/**
 * Core loop: iterate SDKMessages (real or injected), write each to
 * `<sessionDir>/transcript.jsonl`, return exit metadata.
 *
 * The prompt is read from `opts.promptFile` so the file is always read
 * before building any options, even in tests (keeps the testable surface
 * honest about the real contract).
 *
 * When neither `stream` nor `streamFactory` is injected (production path),
 * a `PromptQueue` is built, the prompt-file content is pushed as the first
 * message, and `<sessionDir>/interventions.jsonl` is tailed. Any line
 * written to that file by `session/inject` is forwarded into the queue so
 * the agent picks it up on its next turn without restarting.
 *
 * When a `control: "interrupt"` line is detected in the intervention file,
 * the current SDK query is aborted and a new one is started with
 * `options.resume = <sdkSessionId>` so the SDK restores conversation history
 * and the agent sees the correction as the next user message.
 */
export async function runAgentSdkLaunch(opts: RunAgentSdkLaunchOpts): Promise<RunAgentSdkLaunchResult> {
  const { sessionId, sessionDir, worktree, promptFile, model, maxTurns, maxBudgetUsd, systemAppend } = opts;

  const promptText = readFileSync(promptFile, "utf8");
  const transcriptPath = join(sessionDir, "transcript.jsonl");
  mkdirSync(dirname(transcriptPath), { recursive: true });

  function writeLine(obj: unknown): void {
    appendFileSync(transcriptPath, JSON.stringify(obj) + "\n");
  }

  const forwardDeps: ForwardDeps = {
    hookEndpoint: opts.hookEndpoint,
    arkSessionId: sessionId,
    stage: opts.stage ?? null,
    authToken: opts.authToken,
    fetchFn: opts.fetchFn,
  };

  // Legacy injected-stream path (existing tests): skip the real SDK and the
  // queue entirely. The stream is used exactly as before.
  if (opts.stream !== undefined) {
    const dr = await drainStream(opts.stream, writeLine, forwardDeps);
    return { exitCode: dr.exitCode, sawResult: dr.sawResult };
  }

  // Build a PromptQueue so the agent can receive mid-session interventions.
  const queue = new PromptQueue();
  queue.push(promptText);

  // streamFactory path: test injects a factory that receives the queue.
  // Supports the interrupt-resume loop for tests that verify the D3 flow.
  if (opts.streamFactory !== undefined) {
    const interventionPath = join(sessionDir, "interventions.jsonl");

    // Mutable holder so the intervention tail always calls abort() on the
    // *current* iteration's controller, even as it changes across resumes.
    const abortHolder = { ref: new AbortController() };
    const interruptFlag = { fired: false };

    const stopTail = startInterventionTail({
      path: interventionPath,
      onMessage: (content) => queue.push(content),
      onInterrupt: (content) => {
        // streamFactory test path: inject the steer and abort. Tests use
        // simple AsyncIterables so the production-path queue-race doesn't
        // apply -- pushing here is safe.
        if (content.length > 0) queue.push(content);
        interruptFlag.fired = true;
        abortHolder.ref.abort();
      },
      onError: (err) => console.error(`[agent-sdk launch] intervention tail error: ${err.message}`),
    });

    let sdkSessionId: string | undefined;
    let attempt = 0;

    try {
      while (true) {
        attempt++;
        abortHolder.ref = new AbortController();
        interruptFlag.fired = false;

        const iterOptions: Record<string, unknown> = {};
        if (sdkSessionId) iterOptions.resume = sdkSessionId;

        const stream = opts.streamFactory(queue, iterOptions);
        const dr = await drainStream(
          stream,
          writeLine,
          forwardDeps,
          abortHolder.ref.signal,
          interruptFlag,
          promptText,
          queue,
        );

        if (dr.sdkSessionId && !sdkSessionId) {
          sdkSessionId = dr.sdkSessionId;
        }

        if (dr.outcome === "interrupted" && attempt < MAX_INTERRUPTS) {
          // Loop -- start a new query with options.resume = sdkSessionId.
          continue;
        }

        return { exitCode: dr.exitCode, sawResult: dr.sawResult };
      }
    } finally {
      stopTail();
      queue.close();
    }
  }

  // Real-SDK path: dynamic import keeps the SDK binary out of test imports.
  const { query } = await import("@anthropic-ai/claude-agent-sdk");

  const apiKey = process.env.ANTHROPIC_API_KEY;
  const baseURL = process.env.ANTHROPIC_BASE_URL;
  const customHeaders = process.env.ANTHROPIC_CUSTOM_HEADERS;

  // Gateway wire-format compat -------------------------------------------------
  // ARK_COMPAT is a comma-separated list of compat modes set by the executor
  // from the runtime's declared `compat:` field. No heuristics: callers opt in
  // explicitly via the runtime YAML.
  //
  // `bedrock` mode -- for gateways that transcode to AWS Bedrock (TrueFoundry,
  // direct Bedrock proxies). Bedrock rejects several fields the Claude binary
  // includes (e.g. `context_management`) and SNI-routes on Host, so we start a
  // local Bun proxy that (a) strips those fields from request bodies,
  // (b) drops the Host / hop-by-hop headers so fetch sets them correctly for
  // the upstream, (c) expands short model slugs (e.g. `claude-sonnet-4-6`) to
  // the full provider-qualified form the gateway expects.
  const compatModes = new Set(
    (process.env.ARK_COMPAT ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length > 0),
  );

  let proxyServer: ReturnType<typeof Bun.serve> | undefined;
  let effectiveBaseURL = baseURL;
  // The model slug reaches launch.ts pre-resolved: the dispatch pipeline turns
  // the agent's catalog id/alias into the concrete provider slug for the
  // gateway in play (e.g. `pi-agentic/global.anthropic.claude-sonnet-4-6` for
  // TF-Bedrock, bare `claude-sonnet-4-6` for Anthropic-direct). This file must
  // NEVER synthesise or rewrite a model slug -- that is the model catalog's
  // job, and keeping the two concerns separate keeps launch.ts free of model
  // knowledge.
  const effectiveModel = model;
  const bedrockCompat = compatModes.has("bedrock");

  if (bedrockCompat && baseURL) {
    // Fields that AWS Bedrock (via TF gateway) does not accept.
    const BEDROCK_STRIP_FIELDS = new Set(["context_management"]);

    // Resolve the forward URL once. The proxy receives requests at /v1/messages
    // and forwards to <baseURL>/v1/messages.
    const forwardBase = baseURL.endsWith("/") ? baseURL.slice(0, -1) : baseURL;

    proxyServer = Bun.serve({
      port: 0, // OS-assigned ephemeral port
      // Generous idle timeout: a single Sonnet/Opus turn can stream for
      // 60-120s before TF returns. Bun.serve's default of 10s tears the
      // socket down mid-response and the SDK surfaces a "socket connection
      // was closed unexpectedly" API error. Pin to 5 minutes -- the SDK's
      // own per-turn timeout is the upper bound, this is just floor.
      idleTimeout: 255,
      async fetch(req) {
        const url = new URL(req.url);
        const targetUrl = `${forwardBase}${url.pathname}${url.search}`;

        // Clone headers for forwarding. Remove hop-by-hop and routing headers
        // that must not be forwarded verbatim: the binary sends "host: localhost:<proxyPort>"
        // which causes TF's gateway to 404 (it routes on the Host header).
        // Let fetch set the correct host for the upstream URL.
        // Strip accept-encoding too so TF responds uncompressed -- the SDK
        // can't decompress zstd (ZstdDecompressionError) and we'd otherwise
        // need to decompress + re-encode in the proxy.
        const SKIP_HEADERS = new Set(["host", "connection", "content-length", "transfer-encoding", "accept-encoding"]);
        const headers: Record<string, string> = {};
        req.headers.forEach((v, k) => {
          if (!SKIP_HEADERS.has(k)) headers[k] = v;
        });
        // Force identity encoding upstream so TF doesn't pick zstd / br based
        // on its own defaults.
        headers["accept-encoding"] = "identity";

        // Inject auth headers from ANTHROPIC_CUSTOM_HEADERS env if the inbound
        // request didn't carry them. The SDK's bundled binary doesn't honor
        // ANTHROPIC_CUSTOM_HEADERS (the standalone CLI does, but the SDK build
        // we wrap does not), so it sends only `x-api-key: dummy` -- which TF
        // rejects 401. We parse CUSTOM_HEADERS here and add the missing ones.
        if (customHeaders) {
          for (const line of customHeaders.split(/\r?\n/)) {
            const idx = line.indexOf(":");
            if (idx <= 0) continue;
            const name = line.slice(0, idx).trim();
            const value = line.slice(idx + 1).trim();
            if (!name || !value) continue;
            const lower = name.toLowerCase();
            if (!(lower in headers)) headers[lower] = value;
          }
        }

        let body: string | undefined;
        if (req.method !== "GET" && req.method !== "HEAD") {
          const raw = await req.text();
          if (raw && headers["content-type"]?.includes("application/json")) {
            try {
              const parsed = JSON.parse(raw);
              for (const field of BEDROCK_STRIP_FIELDS) {
                if (field in parsed) {
                  delete parsed[field];
                }
              }
              body = JSON.stringify(parsed);
            } catch {
              body = raw; // non-JSON: forward as-is
            }
          } else {
            body = raw;
          }
        }

        let upstream: Response;
        try {
          upstream = await fetch(targetUrl, {
            method: req.method,
            headers,
            body,
            // Allow self-signed or SAN-mismatch certs for internal TF gateways.
            tls: { rejectUnauthorized: false } as any,
          });
        } catch (err: any) {
          const msg = err?.message ?? String(err);
          console.error(`[agent-sdk launch] proxy fetch error for ${targetUrl}: ${msg}`);
          return new Response(JSON.stringify({ error: msg }), {
            status: 502,
            headers: { "content-type": "application/json" },
          });
        }

        return new Response(upstream.body, {
          status: upstream.status,
          headers: upstream.headers,
        });
      },
    });

    effectiveBaseURL = `http://localhost:${proxyServer.port}`;
    console.error(`[agent-sdk launch] Bedrock-compat proxy started on port ${proxyServer.port}`);
    // NOTE: model-slug expansion for bedrock gateways used to happen here
    // (pi-agentic/global.anthropic.<x>). That logic moved upstream into the
    // model catalog + resolve-stage pipeline -- by the time we get here the
    // caller has already selected the correct provider slug. See the comment
    // on `effectiveModel` above for why this file is model-agnostic.
  }

  // When custom auth headers are in play (typical for gateway routing like
  // TrueFoundry where ANTHROPIC_API_KEY=dummy and the real bearer is in
  // ANTHROPIC_CUSTOM_HEADERS), the SDK's bundled binary picks up
  // ANTHROPIC_AUTH_TOKEN if it's set in the inherited shell env (a leftover
  // from LiteLLM or another proxy) and uses THAT as the Bearer -- short-
  // circuiting our custom-headers path and producing 401s. Strip it.
  // Mirrors the `make claude-tfy` target's `unset ANTHROPIC_AUTH_TOKEN`.
  // Built-in subagents (Explore etc.) cannot be overridden via the SDK's
  // `agents` option -- the SDK docs explicitly call this out. The bundled
  // claude binary does honour ANTHROPIC_DEFAULT_HAIKU_MODEL, which is the
  // documented escape hatch for non-Anthropic gateways that don't accept
  // the SDK's hardcoded `claude-haiku-4-5-20251001`. The executor sets
  // that env var from the agent-sdk runtime YAML's `default_haiku_model`
  // field, so we just propagate process.env without special-casing it.
  const sdkEnv: Record<string, string | undefined> = {
    ...process.env,
    ...(apiKey ? { ANTHROPIC_API_KEY: apiKey } : {}),
    ...(effectiveBaseURL ? { ANTHROPIC_BASE_URL: effectiveBaseURL } : {}),
    ...(customHeaders ? { ANTHROPIC_CUSTOM_HEADERS: customHeaders } : {}),
  };
  if (customHeaders) {
    delete sdkEnv.ANTHROPIC_AUTH_TOKEN;
  }

  // The Agent SDK shells out to the Claude Code CLI (`cli.js`) as a subprocess.
  // When ark runs as a bun-compile single-file bundle, `require.resolve("./cli.js")`
  // fails because the SDK's own node_modules path isn't on disk. Resolve an
  // explicit path so the SDK can locate the CLI, trying (in order):
  //   1. ARK_CLAUDE_EXECUTABLE_PATH env override
  //   2. `claude` next to the ark binary (release tarballs vendor it here)
  //   3. `claude` on PATH (dev workstations with npm-installed claude-code)
  const claudeExePath = resolveClaudeExecutable();

  // ── Stage-completion contract ────────────────────────────────────────────
  //
  // end_turn is the SDK's "this assistant turn is finished" signal -- NOT
  // "this stage is complete". We make stage completion EXPLICIT via the
  // `complete_stage` tool. The flag below is set by that tool and read by
  // the SDK's Stop hook to decide whether to actually stop the SDK.
  //
  // The SDK is allowed to stop only when:
  //   - complete_stage has been called (agent says it's done), AND
  //   - the user-input PromptQueue has no pending messages.
  //
  // Anything else (model decided to end_turn but no explicit complete, or a
  // new user message arrived in the queue) makes the Stop hook return
  // `decision: "block"` with a reason. The SDK feeds the reason back as a
  // user turn and the agent keeps going.
  let stageCompleteRequested = false;
  let stageCompleteReason: string | undefined;

  // True between an interrupt envelope arriving and the agent's first Stop
  // hook after consuming it. Used to (a) reject any `complete_stage` tool
  // call landing in this window -- a user steer is a side message, not a
  // stage-completion directive, so the agent must NOT terminate the stage
  // in response to it -- and (b) reframe the Stop hook prompt to tell the
  // agent to resume the original task instead of dangling complete_stage
  // as an option. Cleared on the first Stop hook firing after the steer
  // reply lands. The user-input subscriber sets it; the Stop hook clears it.
  let postSteerWindow = false;

  const mcpServers: Record<string, ReturnType<typeof createAskUserMcpServer>> = {};
  if (opts.conductorUrl) {
    mcpServers["ark-ask-user"] = createAskUserMcpServer({
      sessionId,
      conductorUrl: opts.conductorUrl,
      authToken: opts.authToken,
      stage: process.env.ARK_STAGE ?? "",
    });
  }
  mcpServers["ark-stage-control"] = createStageControlMcpServer({
    onCompleteStage: (reason) => {
      // Reject the tool call when it lands inside the post-steer window.
      // Stage completion is the agent's signal that the STAGE'S work is
      // done, not a reaction to user side-message phrasing like "stop now"
      // or "we're done". Returning false short-circuits the tool result
      // with an error string so the agent reads it as "no, you're not done
      // -- keep working on the original task."
      if (postSteerWindow) {
        return false;
      }
      stageCompleteRequested = true;
      stageCompleteReason = reason;
      return true;
    },
  });

  const sdkOptions: Options = {
    cwd: worktree,
    env: sdkEnv as Record<string, string | undefined>,
    allowedTools: [
      "Read",
      "Write",
      "Edit",
      "Bash",
      "Glob",
      "Grep",
      "mcp__ark-ask-user__ask_user",
      "mcp__ark-stage-control__complete_stage",
    ],
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    executable: "bun",
    model: effectiveModel,
    maxTurns,
    maxBudgetUsd,
    systemPrompt: systemAppend ? { type: "preset", preset: "claude_code", append: systemAppend } : undefined,
    ...(claudeExePath ? { pathToClaudeCodeExecutable: claudeExePath } : {}),
    ...(Object.keys(mcpServers).length > 0 ? { mcpServers } : {}),
    // Stop hook: gates the SDK's actual stop on the explicit-complete +
    // empty-queue contract above. Returning `decision: "block"` with a
    // `reason` makes the SDK feed that text back as a user message and
    // continue iterating; returning `{}` lets the SDK stop normally.
    hooks: {
      Stop: [
        {
          hooks: [
            async () => {
              const queueHasPending = queue.pendingCount() > 0;
              if (stageCompleteRequested && !queueHasPending) {
                return {};
              }
              // Post-steer end_turn: the agent just answered a user side
              // message. Don't dangle complete_stage as an option (the
              // tool also rejects in this window). Tell the agent to
              // resume the original task. Clear the window so subsequent
              // end_turns get the normal complete_stage / continue prompt
              // once the agent is back to actual stage work.
              if (postSteerWindow) {
                postSteerWindow = false;
                return {
                  decision: "block" as const,
                  reason:
                    "You just answered a user side message (steer). Resume the original task you " +
                    "were working on before this interruption. A steer is a side conversation, not a " +
                    "stage-completion request -- do not call `mcp__ark-stage-control__complete_stage` " +
                    "in response to the user's words; only call it when the stage's actual work is " +
                    "finished.",
                };
              }
              const reason = !stageCompleteRequested
                ? "end_turn fired but `complete_stage` has not been called. Either continue working " +
                  "on the stage's task, or call `mcp__ark-stage-control__complete_stage` if the work " +
                  "the user asked for in this stage is finished."
                : "A new user message arrived after you signaled completion. Read it from the next " +
                  "user turn and respond before stopping.";
              return { decision: "block" as const, reason };
            },
          ],
        },
      ],
    },
  };

  // AbortController is used ONLY for hard process aborts (SIGTERM/SIGINT).
  // User-initiated mid-turn interrupts go through the SDK's documented
  // `query.interrupt()` method instead (see currentStream below). Aborting
  // the controller while the SDK is mid-stream from the gateway leaves the
  // for-await iterator parked indefinitely on some HTTP/2 transports --
  // the SDK only honours abort cleanly between turns. interrupt() is the
  // right primitive: it ends the in-flight turn, yields a final result
  // message, and we restart with `resume: <sessionId>` to inject the
  // queued user message as the next turn.
  const abortHolder = { ref: new AbortController() };
  const interruptFlag = { fired: false };

  // Holds the Query object for the current iteration. The user-input
  // subscriber's onInterrupt closes over this and calls .interrupt() on
  // whatever is current at the moment the steer arrives.
  const currentStream: { ref: { interrupt(): Promise<void> } | null } = { ref: null };

  // Steer content arriving on interrupt envelopes is buffered here and
  // drained into `queue` at the START of the next attempt iteration.
  // Pushing directly to the queue would race with the dying SDK iterator
  // -- if it had a `next()` resolver parked, the steer would be delivered
  // to it and lost when the abort tears the turn down. Buffering ensures
  // every steer ends up in front of a freshly-spawned iterator.
  const pendingInterruptSteers: string[] = [];

  const onSigterm = () => abortHolder.ref.abort();
  const onSigint = () => abortHolder.ref.abort();
  process.on("SIGTERM", onSigterm);
  process.on("SIGINT", onSigint);

  function fireInterrupt(content: string): void {
    interruptFlag.fired = true;
    // Open the post-steer window. The flag stays set through the agent's
    // first end_turn after consuming the steer. While open: the
    // complete_stage tool rejects, and the Stop hook tells the agent to
    // resume the original task. The Stop hook clears the flag.
    postSteerWindow = true;
    if (content.length > 0) {
      pendingInterruptSteers.push(content);
    }
    const s = currentStream.ref;
    if (!s) {
      console.error("[user-input] interrupt requested but no active SDK stream; steer will run on next turn");
      return;
    }
    // Fire-and-forget: SDK ends the current turn and yields a result
    // message, drainStream returns "interrupted", outer loop drains the
    // pending steers into the queue and restarts with `resume`.
    s.interrupt().catch((err) => {
      console.error(`[user-input] query.interrupt() rejected: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  // Mid-session interventions: prefer the arkd wire stream (production path)
  // when ARK_ARKD_URL is reachable; fall back to the legacy file-tail for
  // dev / test scenarios that run without arkd. Both paths feed the same
  // queue + interrupt machinery.
  const arkdUrlForStream = process.env.ARK_ARKD_URL;
  // The conductor publishes `session: session.session_id` (the handle,
  // e.g. `ark-s-<id>`) on the user-input channel, NOT the bare session
  // id. Filter by the same value here. The launcher exports the handle
  // as ARK_SESSION_HANDLE; fall back to deriving it from sessionId for
  // older binaries that didn't set the env var.
  const sessionHandle = process.env.ARK_SESSION_HANDLE ?? `ark-${sessionId}`;
  const stopTail: () => void = arkdUrlForStream
    ? subscribeUserMessages({
        arkdUrl: arkdUrlForStream,
        sessionName: sessionHandle,
        authToken: process.env.ARK_API_TOKEN,
        onMessage: (content) => queue.push(content),
        onInterrupt: fireInterrupt,
        onError: (err) => console.error(`[agent-sdk launch] intervention stream error: ${err.message}`),
      })
    : startInterventionTail({
        path: join(sessionDir, "interventions.jsonl"),
        onMessage: (content) => queue.push(content),
        onInterrupt: fireInterrupt,
        onError: (err) => console.error(`[agent-sdk launch] intervention tail error: ${err.message}`),
      });

  let sdkSessionId: string | undefined;
  let attempt = 0;

  try {
    while (true) {
      attempt++;
      abortHolder.ref = new AbortController();
      interruptFlag.fired = false;
      sdkOptions.abortController = abortHolder.ref;

      if (sdkSessionId) {
        (sdkOptions as Record<string, unknown>).resume = sdkSessionId;
      }

      // Detach any parked iterator from the previous (now aborted) attempt
      // before pushing fresh content. Without this, the dead iterator's
      // resolver still sits at the head of the queue's resolver list and
      // the next push() delivers there -- the message gets eaten by the
      // dead iteration and never reaches the new query() we are about to
      // start.
      queue.detachIterators();

      // Drain steers that arrived on interrupt envelopes during the
      // previous iteration. They could not be pushed to the queue back
      // then because the dying SDK iterator might have grabbed them via
      // its parked `next()` resolver and lost them on abort.
      while (pendingInterruptSteers.length > 0) {
        const steer = pendingInterruptSteers.shift()!;
        queue.push(steer);
        console.error(`[agent-sdk launch] pushed pending interrupt steer to queue (${steer.length} bytes)`);
      }

      console.error(
        `[agent-sdk launch] starting query attempt=${attempt} resume=${sdkSessionId ?? "none"} ` +
          `queue.pendingCount=${queue.pendingCount()}`,
      );
      const stream = query({ prompt: queue, options: sdkOptions });
      currentStream.ref = stream;
      const dr = await drainStream(
        stream,
        writeLine,
        forwardDeps,
        abortHolder.ref.signal,
        interruptFlag,
        promptText,
        queue,
      );
      currentStream.ref = null;
      console.error(
        `[agent-sdk launch] query finished attempt=${attempt} outcome=${dr.outcome} ` +
          `sawResult=${dr.sawResult} interrupted=${interruptFlag.fired}`,
      );

      if (dr.sdkSessionId && !sdkSessionId) {
        sdkSessionId = dr.sdkSessionId;
      }

      // SIGTERM/SIGINT abort -- surface hard abort to caller.
      if (dr.outcome === "aborted") {
        return { exitCode: 1, sawResult: dr.sawResult };
      }

      if (dr.outcome === "interrupted" && attempt < MAX_INTERRUPTS) {
        // Loop -- start a new query with options.resume = sdkSessionId.
        continue;
      }

      // User-initiated interrupt via query.interrupt(): the SDK ends the
      // turn cleanly with a result message (outcome="completed"). The user
      // has more to say -- restart with resume so the queued steer becomes
      // the next turn. Always loop, even if the agent happened to call
      // complete_stage in the same final flush.
      if (interruptFlag.fired && attempt < MAX_INTERRUPTS) {
        continue;
      }

      // The Stop hook only allows the SDK to actually stop when
      // complete_stage was called AND the queue is empty. So a "completed"
      // outcome here means the agent has finalised its work; close out.
      // Any other outcome (interrupted past the attempt cap, etc.) also
      // exits cleanly via the existing return below.
      if (dr.outcome === "completed" && stageCompleteRequested && queue.pendingCount() === 0) {
        return {
          exitCode: dr.exitCode,
          sawResult: dr.sawResult,
          stageCompleteReason,
        } as RunAgentSdkLaunchResult;
      }

      // Defensive: if drainStream returned "completed" with sawResult but
      // the agent didn't yet call complete_stage, loop back so the Stop
      // hook can run again on the next turn (the production-hook path).
      // Skipping when sawResult=false because then the SDK iterator ended
      // without yielding ANY messages (stream broken / auth failure /
      // empty resume); looping would just busy-spin re-creating dead
      // streams. Surface that state to the caller as a clean failure.
      if (dr.outcome === "completed" && dr.sawResult) continue;

      return { exitCode: dr.exitCode, sawResult: dr.sawResult };
    }
  } finally {
    process.off("SIGTERM", onSigterm);
    process.off("SIGINT", onSigint);
    stopTail();
    queue.close();
    if (proxyServer) {
      proxyServer.stop(true);
    }
  }
}

// -- Entry point --------------------------------------------------------------
// Only runs when executed directly (bun launch.ts / compiled binary).
// Tests import `runAgentSdkLaunch` directly without hitting this block.

function need(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`[agent-sdk launch] missing required env var: ${name}`);
    process.exit(2);
  }
  return v;
}

async function main(): Promise<void> {
  const sessionId = need("ARK_SESSION_ID");
  const sessionDir = need("ARK_SESSION_DIR");
  const worktree = need("ARK_WORKTREE");
  const promptFile = need("ARK_PROMPT_FILE");

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error(
      "[agent-sdk launch] ANTHROPIC_API_KEY is required. Set it in the environment or via StageSecretResolver.",
    );
    process.exit(2);
  }

  const model = process.env.ARK_MODEL;
  const maxTurns = optionalNumber("ARK_MAX_TURNS");
  const maxBudgetUsd = optionalNumber("ARK_MAX_BUDGET_USD");
  const systemAppend = process.env.ARK_SYSTEM_PROMPT_APPEND;

  // Hook endpoint resolution: prefer ARK_ARKD_URL (the local arkd on the
  // worker, which buffers on its `hooks` channel; the conductor subscribes
  // via /channel/hooks/subscribe). Falls back to ARK_CONDUCTOR_URL for
  // local dispatch where the agent runs on the conductor host. Tests
  // leave both unset to disable forwarding.
  const arkdUrl = process.env.ARK_ARKD_URL;
  const conductorUrl = process.env.ARK_CONDUCTOR_URL;
  const hookEndpoint = arkdUrl
    ? `${arkdUrl}/channel/hooks/publish`
    : conductorUrl
      ? `${conductorUrl}/hooks/status`
      : undefined;
  if (!hookEndpoint) {
    console.warn("[agent-sdk launch] neither ARK_ARKD_URL nor ARK_CONDUCTOR_URL is set -- hook forwarding disabled");
  }
  const authToken = process.env.ARK_API_TOKEN;

  // Stage label is baked into the runtime at provisioning time. The
  // conductor's launcher writes ARK_STAGE from session.stage in the
  // dispatch context; once the agent process is up, this label is
  // immutable for the lifetime of the runtime and is stamped onto every
  // hook the agent emits. The conductor's event log uses this as the
  // source of truth instead of re-reading session.stage at log time
  // (which flaps when the state machine advances mid-flight).
  const stage = process.env.ARK_STAGE;

  const result = await runAgentSdkLaunch({
    sessionId,
    sessionDir,
    worktree,
    promptFile,
    model,
    maxTurns,
    maxBudgetUsd,
    systemAppend,
    hookEndpoint,
    stage,
    // Pass the conductor URL through unchanged for the ask-user MCP path.
    // That feature requires a direct conductor reach for inbound RPCs and
    // doesn't have a "via arkd" route yet -- when only ARK_ARKD_URL is set
    // (remote dispatch), ask-user is silently disabled.
    conductorUrl,
    authToken,
  });

  process.exit(result.exitCode);
}

// Bun sets import.meta.main = true when the file is the entry point.
if (import.meta.main) {
  main().catch((err) => {
    console.error("[agent-sdk launch] fatal:", err);
    process.exit(1);
  });
}
