/**
 * Tests for message/send and message/markRead RPC handlers.
 *
 * Verifies that:
 * - message/send persists user messages to the messages table
 * - message/markRead marks messages as read
 * - session/messages returns interleaved user + agent messages
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { AppContext } from "../../core/app.js";
import { registerSessionHandlers } from "../handlers/session.js";
import { registerMessagingHandlers } from "../handlers/messaging.js";
import { Router } from "../router.js";
import { createRequest, type JsonRpcResponse } from "../../protocol/types.js";

let app: AppContext;
beforeAll(async () => {
  app = await AppContext.forTestAsync();
  await app.boot();
});
afterAll(async () => {
  await app?.shutdown();
});

let router: Router;

beforeEach(() => {
  router = new Router();
  registerSessionHandlers(router, app);
  registerMessagingHandlers(router, app);
});

/** Helper to create a session and return its id. Simulates a dispatched session with session_id set. */
async function createSession(summary = "test"): Promise<string> {
  const res = await router.dispatch(createRequest(1, "session/start", { summary, repo: ".", flow: "bare" }));
  const result = (res as JsonRpcResponse).result as Record<string, any>;
  const id = result.session.id;
  // Set session_id to simulate a dispatched session (send() requires it)
  await app.sessions.update(id, { session_id: "ark-" + id, status: "running" });
  return id;
}

/** Helper to list messages for a session via RPC. */
async function listMessages(sessionId: string): Promise<any[]> {
  const res = await router.dispatch(createRequest(1, "session/messages", { sessionId }));
  const result = (res as JsonRpcResponse).result as Record<string, any>;
  return result.messages;
}

describe("messaging handlers", async () => {
  it("message/send persists user message even when delivery fails", async () => {
    const sessionId = await createSession("send-test");
    // Send will fail at sendReliable (no tmux session) but should still persist
    await router.dispatch(createRequest(1, "message/send", { sessionId, content: "hello" }));

    // The message should be persisted regardless of delivery outcome
    const messages = await listMessages(sessionId);
    const userMsg = messages.find((m: any) => m.role === "user" && m.content === "hello");
    expect(userMsg).toBeDefined();
    expect(userMsg.role).toBe("user");
    expect(userMsg.type).toBe("text");
  });

  it("message/send persists user message to conversation history", async () => {
    const sessionId = await createSession("persist-test");
    // Send a message -- it will be persisted even if delivery to tmux fails
    await router.dispatch(createRequest(1, "message/send", { sessionId, content: "hello from user" }));

    // Query messages via session/messages RPC
    const messages = await listMessages(sessionId);
    const userMsg = messages.find((m: any) => m.role === "user" && m.content === "hello from user");
    expect(userMsg).toBeDefined();
    expect(userMsg.role).toBe("user");
    expect(userMsg.type).toBe("text");
    expect(userMsg.content).toBe("hello from user");
  });

  it("user and agent messages are interleaved correctly", async () => {
    const sessionId = await createSession("interleave-test");

    // Persist a user message directly (simulating what send() does before delivery)
    await app.messages.send(sessionId, "user", "user msg 1", "text");

    // Simulate an agent message directly (as conductor would)
    await app.messages.send(sessionId, "agent", "agent reply 1", "text");

    // Another user message
    await app.messages.send(sessionId, "user", "user msg 2", "text");

    const messages = await listMessages(sessionId);
    expect(messages.length).toBe(3);
    expect(messages[0].role).toBe("user");
    expect(messages[0].content).toBe("user msg 1");
    expect(messages[1].role).toBe("agent");
    expect(messages[1].content).toBe("agent reply 1");
    expect(messages[2].role).toBe("user");
    expect(messages[2].content).toBe("user msg 2");
  });

  it("message/markRead marks messages as read", async () => {
    const sessionId = await createSession("markread-test");

    // Add agent messages (only agent messages count as unread)
    await app.messages.send(sessionId, "agent", "msg 1", "text");
    await app.messages.send(sessionId, "agent", "msg 2", "text");

    expect(await app.messages.unreadCount(sessionId)).toBe(2);

    // Mark read via RPC
    const res = await router.dispatch(createRequest(1, "message/markRead", { sessionId }));
    const result = (res as JsonRpcResponse).result as Record<string, any>;
    expect(result.ok).toBe(true);

    expect(await app.messages.unreadCount(sessionId)).toBe(0);
  });

  it("session/messages returns empty array for session with no messages", async () => {
    const sessionId = await createSession("empty-msgs");
    const messages = await listMessages(sessionId);
    expect(messages).toEqual([]);
  });

  it("message/send to nonexistent session returns ok:false", async () => {
    const res = await router.dispatch(
      createRequest(1, "message/send", { sessionId: "s-nonexistent", content: "hello" }),
    );
    const result = (res as JsonRpcResponse).result as Record<string, any>;
    expect(result.ok).toBe(false);
    expect(result.message).toBeDefined();
  });

  // ── gate/reject ──────────────────────────────────────────────────────────
  //
  // Exercises the RPC surface: the handler wires `gate/reject` through to
  // SessionService.rejectReviewGate and returns its {ok, message, sessionId}
  // shape. The deeper rework-prompt/max-rejections semantics are covered by
  // packages/core/__tests__/reject-review-gate.test.ts.

  it("gate/reject returns ok:false for a nonexistent session", async () => {
    const res = await router.dispatch(createRequest(1, "gate/reject", { sessionId: "s-nonexistent", reason: "nope" }));
    const result = (res as JsonRpcResponse).result as Record<string, any>;
    expect(result.ok).toBe(false);
    expect(result.message).toContain("not found");
  });

  it("gate/reject requires a sessionId parameter", async () => {
    const res = await router.dispatch(createRequest(1, "gate/reject", { reason: "forgot id" }));
    // The dispatcher turns thrown errors into JSON-RPC error responses.
    const err = (res as { error?: { message: string } }).error;
    expect(err?.message ?? "").toContain("sessionId");
  });
});
