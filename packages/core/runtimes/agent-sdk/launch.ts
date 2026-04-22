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

import { appendFileSync, mkdirSync, readFileSync } from "fs";
import { dirname, join } from "path";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { startInterventionTail } from "./intervention-tail.js";

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
   * Alternative injection point for tests that need to drive the prompt queue.
   * When provided, `streamFactory(queue)` is called with the PromptQueue and
   * must return the AsyncIterable<unknown> to drain. Ignored when `stream` is set.
   */
  streamFactory?: (prompt: AsyncIterable<SDKUserMessage>) => AsyncIterable<unknown>;
  /**
   * Conductor base URL (e.g. "http://localhost:19100"). When undefined,
   * hook forwarding is skipped entirely. In production, read from
   * ARK_CONDUCTOR_URL env var. Undefined in tests that do not inject it.
   */
  conductorUrl?: string;
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
function messageToHooks(msg: unknown, arkSessionId: string): Array<Record<string, unknown>> {
  const m = msg as Record<string, unknown>;
  const type = m.type as string | undefined;

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
      },
    ];
  }

  if (type === "assistant") {
    const message = m.message as Record<string, unknown> | undefined;
    const content = (message?.content ?? []) as Array<Record<string, unknown>>;
    const hooks: Array<Record<string, unknown>> = [];
    for (const block of content) {
      if ((block.type as string | undefined) === "tool_use") {
        hooks.push({
          hook_event_name: "PreToolUse",
          session_id: arkSessionId,
          tool_name: block.name,
          tool_input: block.input,
          tool_use_id: block.id,
        });
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

  // stream_event, assistant-text-only, compact_boundary, and anything else: skip
  return [];
}

interface ForwardDeps {
  conductorUrl: string | undefined;
  arkSessionId: string;
  authToken?: string;
  fetchFn?: typeof fetch;
}

/**
 * Forward one SDKMessage to the conductor /hooks/status endpoint.
 *
 * Each forward is awaited serially to preserve event order. Any network
 * error is logged to stderr but never propagates -- a conductor outage must
 * not break the agent loop. The transcript.jsonl remains the source of truth.
 */
async function forwardToConductor(message: unknown, deps: ForwardDeps): Promise<void> {
  if (!deps.conductorUrl) return;
  const hooks = messageToHooks(message, deps.arkSessionId);
  const doFetch = deps.fetchFn ?? fetch;
  for (const hook of hooks) {
    try {
      await doFetch(`${deps.conductorUrl}/hooks/status?session=${encodeURIComponent(deps.arkSessionId)}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(deps.authToken ? { Authorization: `Bearer ${deps.authToken}` } : {}),
        },
        body: JSON.stringify(hook),
      });
    } catch (err) {
      const msg = (err as Error)?.message ?? String(err);
      console.error(`[agent-sdk launch] conductor hook forward failed: ${msg}`);
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

/**
 * Drain a message stream: write each message to transcript.jsonl, forward
 * hook payloads to the conductor, and return exit metadata. Shared by both
 * the injected-stream path and the real-SDK path.
 */
async function drainStream(
  stream: AsyncIterable<unknown>,
  writeLine: (obj: unknown) => void,
  forwardDeps: ForwardDeps,
): Promise<RunAgentSdkLaunchResult> {
  let sawResult = false;
  let exitCode = 0;

  try {
    for await (const message of stream) {
      writeLine(message);
      await forwardToConductor(message, forwardDeps);
      const msg = message as { type?: string; is_error?: boolean };
      if (msg.type === "result") {
        sawResult = true;
        if (msg.is_error) exitCode = 1;
      }
    }
  } catch (err: unknown) {
    const e = err as { message?: string } | null;
    writeLine({ type: "error", source: "launch", message: String(e?.message ?? err) });
    exitCode = 1;
  }

  if (!sawResult && exitCode === 0) {
    writeLine({ type: "error", source: "launch", message: "stream ended without result message" });
    exitCode = 1;
  }

  return { exitCode, sawResult };
}

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
    conductorUrl: opts.conductorUrl,
    arkSessionId: sessionId,
    authToken: opts.authToken,
    fetchFn: opts.fetchFn,
  };

  // Legacy injected-stream path (existing tests): skip the real SDK and the
  // queue entirely. The stream is used exactly as before.
  if (opts.stream !== undefined) {
    return drainStream(opts.stream, writeLine, forwardDeps);
  }

  // Build a PromptQueue so the agent can receive mid-session interventions.
  const queue = new PromptQueue();
  queue.push(promptText);

  // streamFactory path: test injects a factory that receives the queue.
  if (opts.streamFactory !== undefined) {
    const interventionPath = join(sessionDir, "interventions.jsonl");
    const stopTail = startInterventionTail({
      path: interventionPath,
      onMessage: (content) => queue.push(content),
      onError: (err) => console.error(`[agent-sdk launch] intervention tail error: ${err.message}`),
    });
    try {
      return await drainStream(opts.streamFactory(queue), writeLine, forwardDeps);
    } finally {
      stopTail();
      queue.close();
    }
  }

  // Real-SDK path: dynamic import keeps the SDK binary out of test imports.
  const { query } = await import("@anthropic-ai/claude-agent-sdk");

  const apiKey = process.env.ANTHROPIC_API_KEY;
  const baseURL = process.env.ANTHROPIC_BASE_URL;

  const sdkOptions: Options = {
    cwd: worktree,
    env: {
      ...process.env,
      ...(apiKey ? { ANTHROPIC_API_KEY: apiKey } : {}),
      ...(baseURL ? { ANTHROPIC_BASE_URL: baseURL } : {}),
    } as Record<string, string | undefined>,
    allowedTools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    executable: "bun",
    model,
    maxTurns,
    maxBudgetUsd,
    systemPrompt: systemAppend ? { type: "preset", preset: "claude_code", append: systemAppend } : undefined,
  };

  const abort = new AbortController();
  const onSigterm = () => abort.abort();
  const onSigint = () => abort.abort();
  process.on("SIGTERM", onSigterm);
  process.on("SIGINT", onSigint);
  sdkOptions.abortController = abort;

  const interventionPath = join(sessionDir, "interventions.jsonl");
  const stopTail = startInterventionTail({
    path: interventionPath,
    onMessage: (content) => queue.push(content),
    onError: (err) => console.error(`[agent-sdk launch] intervention tail error: ${err.message}`),
  });

  try {
    return await drainStream(query({ prompt: queue, options: sdkOptions }), writeLine, forwardDeps);
  } finally {
    process.off("SIGTERM", onSigterm);
    process.off("SIGINT", onSigint);
    stopTail();
    queue.close();
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

  const conductorUrl = process.env.ARK_CONDUCTOR_URL;
  if (!conductorUrl) {
    console.warn("[agent-sdk launch] ARK_CONDUCTOR_URL is not set -- conductor hook forwarding disabled");
  }
  const authToken = process.env.ARK_API_TOKEN;

  const result = await runAgentSdkLaunch({
    sessionId,
    sessionDir,
    worktree,
    promptFile,
    model,
    maxTurns,
    maxBudgetUsd,
    systemAppend,
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
