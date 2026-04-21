/**
 * Tests for the messages table -- addMessage, getMessages, unread counts.
 */

import { describe, it, expect } from "bun:test";
import type { MessageRole, MessageType } from "../../types/index.js";

async function addMessage(opts: { session_id: string; role: MessageRole; content: string; type?: MessageType }) {
  return getApp().messages.send(opts.session_id, opts.role, opts.content, opts.type);
}
async function getMessages(sessionId: string, opts?: { limit?: number }) {
  return getApp().messages.list(sessionId, opts);
}
async function getUnreadCount(sessionId: string) {
  return getApp().messages.unreadCount(sessionId);
}
async function markMessagesRead(sessionId: string) {
  return getApp().messages.markRead(sessionId);
}
import { withTestContext } from "./test-helpers.js";
import { getApp } from "./test-helpers.js";

withTestContext();

describe("Messages", () => {
  it("addMessage stores a message", async () => {
    const session = await getApp().sessions.create({ summary: "test" });
    const msg = await addMessage({ session_id: session.id, role: "user", content: "hello" });
    expect(typeof msg.id).toBe("number");
    expect(msg.role).toBe("user");
    expect(msg.content).toBe("hello");
    expect(msg.type).toBe("text");
    expect(msg.read).toBe(false);
  });

  it("addMessage with custom type", async () => {
    const session = await getApp().sessions.create({ summary: "test" });
    const msg = await addMessage({ session_id: session.id, role: "agent", content: "done", type: "completed" });
    expect(msg.type).toBe("completed");
    expect(msg.role).toBe("agent");
  });

  it("getMessages returns messages in chronological order", async () => {
    const session = await getApp().sessions.create({ summary: "test" });
    await addMessage({ session_id: session.id, role: "user", content: "first" });
    await addMessage({ session_id: session.id, role: "agent", content: "second" });
    await addMessage({ session_id: session.id, role: "user", content: "third" });

    const msgs = await getMessages(session.id);
    expect(msgs.length).toBe(3);
    expect(msgs[0].content).toBe("first");
    expect(msgs[1].content).toBe("second");
    expect(msgs[2].content).toBe("third");
  });

  it("getMessages respects limit", async () => {
    const session = await getApp().sessions.create({ summary: "test" });
    for (let i = 0; i < 10; i++) {
      await addMessage({ session_id: session.id, role: "user", content: `msg-${i}` });
    }
    const msgs = await getMessages(session.id, { limit: 3 });
    expect(msgs.length).toBe(3);
  });

  it("getMessages isolates by session", async () => {
    const s1 = await getApp().sessions.create({ summary: "s1" });
    const s2 = await getApp().sessions.create({ summary: "s2" });
    await addMessage({ session_id: s1.id, role: "user", content: "for s1" });
    await addMessage({ session_id: s2.id, role: "user", content: "for s2" });

    expect((await getMessages(s1.id)).length).toBe(1);
    expect((await getMessages(s2.id)).length).toBe(1);
    expect((await getMessages(s1.id))[0].content).toBe("for s1");
  });

  it("getUnreadCount counts only unread agent messages", async () => {
    const session = await getApp().sessions.create({ summary: "test" });
    await addMessage({ session_id: session.id, role: "user", content: "hello" });
    await addMessage({ session_id: session.id, role: "agent", content: "reply" });
    await addMessage({ session_id: session.id, role: "agent", content: "another" });

    expect(await getUnreadCount(session.id)).toBe(2);
  });

  it("getUnreadCount ignores user messages", async () => {
    const session = await getApp().sessions.create({ summary: "test" });
    await addMessage({ session_id: session.id, role: "user", content: "hello" });
    await addMessage({ session_id: session.id, role: "user", content: "hello again" });

    expect(await getUnreadCount(session.id)).toBe(0);
  });

  it("markMessagesRead marks all as read", async () => {
    const session = await getApp().sessions.create({ summary: "test" });
    await addMessage({ session_id: session.id, role: "agent", content: "msg1" });
    await addMessage({ session_id: session.id, role: "agent", content: "msg2" });

    expect(await getUnreadCount(session.id)).toBe(2);
    await markMessagesRead(session.id);
    expect(await getUnreadCount(session.id)).toBe(0);
  });

  it("markMessagesRead only affects specified session", async () => {
    const s1 = await getApp().sessions.create({ summary: "s1" });
    const s2 = await getApp().sessions.create({ summary: "s2" });
    await addMessage({ session_id: s1.id, role: "agent", content: "for s1" });
    await addMessage({ session_id: s2.id, role: "agent", content: "for s2" });

    await markMessagesRead(s1.id);
    expect(await getUnreadCount(s1.id)).toBe(0);
    expect(await getUnreadCount(s2.id)).toBe(1);
  });
});
