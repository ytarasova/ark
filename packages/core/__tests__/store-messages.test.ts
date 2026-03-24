/**
 * Tests for the messages table — addMessage, getMessages, unread counts.
 */

import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import {
  createTestContext, setContext, resetContext,
  getDb, addMessage, getMessages, getUnreadCount, markMessagesRead,
} from "../index.js";
import { createSession } from "../store.js";
import type { TestContext } from "../store.js";

let ctx: TestContext;

beforeEach(() => {
  if (ctx) ctx.cleanup();
  ctx = createTestContext();
  setContext(ctx);
});

afterAll(() => {
  if (ctx) ctx.cleanup();
  resetContext();
});

describe("Messages", () => {
  it("addMessage stores a message", () => {
    const session = createSession({ summary: "test" });
    const msg = addMessage({ session_id: session.id, role: "user", content: "hello" });
    expect(msg.id).toBeTruthy();
    expect(msg.role).toBe("user");
    expect(msg.content).toBe("hello");
    expect(msg.type).toBe("text");
    expect(msg.read).toBe(false);
  });

  it("addMessage with custom type", () => {
    const session = createSession({ summary: "test" });
    const msg = addMessage({ session_id: session.id, role: "agent", content: "done", type: "completed" });
    expect(msg.type).toBe("completed");
    expect(msg.role).toBe("agent");
  });

  it("getMessages returns messages in chronological order", () => {
    const session = createSession({ summary: "test" });
    addMessage({ session_id: session.id, role: "user", content: "first" });
    addMessage({ session_id: session.id, role: "agent", content: "second" });
    addMessage({ session_id: session.id, role: "user", content: "third" });

    const msgs = getMessages(session.id);
    expect(msgs.length).toBe(3);
    expect(msgs[0].content).toBe("first");
    expect(msgs[1].content).toBe("second");
    expect(msgs[2].content).toBe("third");
  });

  it("getMessages respects limit", () => {
    const session = createSession({ summary: "test" });
    for (let i = 0; i < 10; i++) {
      addMessage({ session_id: session.id, role: "user", content: `msg-${i}` });
    }
    const msgs = getMessages(session.id, { limit: 3 });
    expect(msgs.length).toBe(3);
  });

  it("getMessages isolates by session", () => {
    const s1 = createSession({ summary: "s1" });
    const s2 = createSession({ summary: "s2" });
    addMessage({ session_id: s1.id, role: "user", content: "for s1" });
    addMessage({ session_id: s2.id, role: "user", content: "for s2" });

    expect(getMessages(s1.id).length).toBe(1);
    expect(getMessages(s2.id).length).toBe(1);
    expect(getMessages(s1.id)[0].content).toBe("for s1");
  });

  it("getUnreadCount counts only unread agent messages", () => {
    const session = createSession({ summary: "test" });
    addMessage({ session_id: session.id, role: "user", content: "hello" });
    addMessage({ session_id: session.id, role: "agent", content: "reply" });
    addMessage({ session_id: session.id, role: "agent", content: "another" });

    expect(getUnreadCount(session.id)).toBe(2);
  });

  it("getUnreadCount ignores user messages", () => {
    const session = createSession({ summary: "test" });
    addMessage({ session_id: session.id, role: "user", content: "hello" });
    addMessage({ session_id: session.id, role: "user", content: "hello again" });

    expect(getUnreadCount(session.id)).toBe(0);
  });

  it("markMessagesRead marks all as read", () => {
    const session = createSession({ summary: "test" });
    addMessage({ session_id: session.id, role: "agent", content: "msg1" });
    addMessage({ session_id: session.id, role: "agent", content: "msg2" });

    expect(getUnreadCount(session.id)).toBe(2);
    markMessagesRead(session.id);
    expect(getUnreadCount(session.id)).toBe(0);
  });

  it("markMessagesRead only affects specified session", () => {
    const s1 = createSession({ summary: "s1" });
    const s2 = createSession({ summary: "s2" });
    addMessage({ session_id: s1.id, role: "agent", content: "for s1" });
    addMessage({ session_id: s2.id, role: "agent", content: "for s2" });

    markMessagesRead(s1.id);
    expect(getUnreadCount(s1.id)).toBe(0);
    expect(getUnreadCount(s2.id)).toBe(1);
  });
});
