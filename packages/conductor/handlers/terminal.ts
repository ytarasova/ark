/**
 * Terminal JSON-RPC handlers (B9).
 *
 * Provides an alternative to the raw `/terminal/:sessionId` WebSocket route
 * for callers that prefer JSON-RPC over the browser-native raw WS surface.
 *
 * Methods:
 *   terminal/subscribe({ sessionId }) -> { handle: string }
 *     Opens an attach handle via arkd and starts pumping terminal frames to
 *     the caller as `terminal/frame` notifications (bytes base64-encoded).
 *     `subscription.onClose()` tears down the stream and the arkd handle.
 *
 *   terminal/input({ handle, bytes }) -> { ok: boolean }
 *     Sends base64-encoded input bytes to the session owning `handle`.
 *     `handle` must have been obtained from a prior `terminal/subscribe` call
 *     on the same JSON-RPC connection.
 *
 * NOTE: The raw `/terminal/:sessionId` WebSocket bridge in `packages/conductor/
 * index.ts` is unchanged and continues to serve the browser. These RPC
 * methods are an additive surface for programmatic callers (CLI, test
 * harnesses, MCP tool use) that already hold a JSON-RPC connection.
 */

import { Router } from "../router.js";
import type { AppContext } from "../../core/app.js";
import { extract } from "../validate.js";
import { ErrorCodes, RpcError } from "../../protocol/types.js";
import { resolveTenantApp } from "./scope-helpers.js";
import { ArkdClient } from "../../arkd/client/index.js";
import { DEFAULT_ARKD_URL } from "../../core/constants.js";
import { logDebug } from "../../core/observability/structured-log.js";

// ── Handle registry ──────────────────────────────────────────────────────────
//
// Maps a JSON-RPC-level handle (a UUID we generate) to the underlying arkd
// client + stream handle so terminal/input can route without re-opening the
// session. The registry is process-global because JSON-RPC connections share
// the same Bun process; handles are unregistered in the onClose callback so
// a dead WS can't leave stale entries indefinitely.

interface TerminalEntry {
  sessionId: string;
  tmuxName: string;
  arkdClient: ArkdClient;
  streamHandle: string;
  abort: AbortController;
}

const terminalHandles = new Map<string, TerminalEntry>();

/** Generate a short unique handle string. */
function makeHandle(): string {
  return `trpc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Resolve the arkd URL + optional auth token for a session. Mirrors the
 * `resolveArkdForSession` helper in `packages/conductor/index.ts` but is
 * self-contained here so the handlers file has no import coupling to the
 * WS server.
 */
async function resolveArkdForSession(
  app: AppContext,
  session: { compute_name?: string | null },
): Promise<{ arkdUrl: string; token: string | null }> {
  const token = process.env.ARK_ARKD_TOKEN ?? null;
  const fallback = process.env.ARK_ARKD_URL || DEFAULT_ARKD_URL;

  if (!session.compute_name) return { arkdUrl: fallback, token };

  const compute = await app.computes.get(session.compute_name);
  if (!compute) return { arkdUrl: fallback, token };

  const computeImpl = app.getCompute(compute.compute_kind);
  if (computeImpl?.attachExistingHandle) {
    const handle = computeImpl.attachExistingHandle({
      name: compute.name,
      status: compute.status,
      config: (compute.config ?? {}) as Record<string, unknown>,
    });
    if (handle) {
      try {
        return { arkdUrl: computeImpl.getArkdUrl(handle), token };
      } catch (err: any) {
        logDebug("terminal-rpc", `compute.getArkdUrl threw: ${err?.message ?? err}; using fallback`);
      }
    }
  }
  return { arkdUrl: fallback, token };
}

export function registerTerminalHandlers(router: Router, app: AppContext): void {
  // ── terminal/subscribe ────────────────────────────────────────────────────
  //
  // Opens a terminal attach handle via arkd and begins streaming pane bytes
  // to the caller as `terminal/frame` JSON-RPC notifications.
  //
  // Returns immediately with `{ handle }` so the caller can start sending
  // input before the first frame arrives. Frames are pushed asynchronously
  // as long as the connection's Subscription is open.

  router.handle("terminal/subscribe", async (params, notify, ctx, subscription) => {
    const { sessionId } = extract<{ sessionId: string }>(params, ["sessionId"]);
    const scoped = resolveTenantApp(app, ctx);

    const session = await scoped.sessions.get(sessionId);
    if (!session) throw new RpcError(`Session ${sessionId} not found`, ErrorCodes.SESSION_NOT_FOUND);
    if (!session.session_id) {
      throw new RpcError(`Session ${sessionId} has no live tmux pane`, ErrorCodes.INVALID_PARAMS);
    }

    const tmuxName = session.session_id;
    const { arkdUrl, token } = await resolveArkdForSession(scoped, session);
    const arkdClient = new ArkdClient(arkdUrl, token ? { token } : undefined);

    // Open the attach handle on arkd.
    const opened = await arkdClient.attachOpen({ sessionName: tmuxName });
    if (!opened.ok) {
      throw new RpcError(`arkd refused attachOpen for session ${sessionId}`, ErrorCodes.INTERNAL_ERROR);
    }

    const handle = makeHandle();
    const abort = new AbortController();

    terminalHandles.set(handle, {
      sessionId,
      tmuxName,
      arkdClient,
      streamHandle: opened.streamHandle,
      abort,
    });

    // Pump the byte stream asynchronously. Each chunk is base64-encoded and
    // pushed as a `terminal/frame` notification.
    const pump = async (): Promise<void> => {
      let streamResp: Response | null = null;
      try {
        streamResp = await fetch(`${arkdUrl}/agent/attach/stream?handle=${encodeURIComponent(opened.streamHandle)}`, {
          headers: token ? { Authorization: `Bearer ${token}` } : undefined,
          signal: abort.signal,
        });
        if (!streamResp.ok || !streamResp.body) return;
        const reader = streamResp.body.getReader();
        while (!abort.signal.aborted) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value && value.byteLength > 0) {
            notify("terminal/frame", {
              sessionId,
              bytes: Buffer.from(value).toString("base64"),
            });
          }
        }
      } catch (err: any) {
        if (!abort.signal.aborted) {
          logDebug("terminal-rpc", `stream error: ${err?.message ?? err}`);
        }
      }
    };

    void pump();

    subscription?.onClose(() => {
      abort.abort();
      terminalHandles.delete(handle);
      // Fire-and-forget -- session may already be gone.
      arkdClient
        .attachClose({ streamHandle: opened.streamHandle })
        .catch(() => logDebug("terminal-rpc", "attachClose failed (session likely gone)"));
    });

    return {
      handle,
      streamHandle: opened.streamHandle,
      initialBuffer: opened.initialBuffer ?? null,
    };
  });

  // ── terminal/input ────────────────────────────────────────────────────────
  //
  // Sends base64-encoded input bytes to the arkd session associated with the
  // given RPC handle. The handle must have been returned by a prior
  // `terminal/subscribe` call on the same connection.

  router.handle("terminal/input", async (params, _notify, _ctx) => {
    const { handle, bytes } = extract<{ handle: string; bytes: string }>(params, ["handle", "bytes"]);

    const entry = terminalHandles.get(handle);
    if (!entry) {
      throw new RpcError(`Unknown terminal handle: ${handle}`, ErrorCodes.INVALID_PARAMS);
    }

    // Decode base64 -> UTF-8 text then send via attachInput.
    const text = Buffer.from(bytes, "base64").toString("utf-8");
    await entry.arkdClient.attachInput({ sessionName: entry.tmuxName, data: text });
    return { ok: true };
  });
}
