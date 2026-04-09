import { describe, it, expect } from "bun:test";
import { getApp } from "../../../core/app.js";
import { startSession } from "../../../core/services/session-orchestration.js";
import { withTestContext } from "../../../core/__tests__/test-helpers.js";

withTestContext();

describe("useMessages internals", () => {
  it("getMessages returns stored messages", () => {
    const app = getApp();
    const session = startSession(app, { summary: "msg-test", repo: "test", flow: "bare", workdir: "/tmp" });
    app.messages.send(session.id, "user", "hello");
    app.messages.send(session.id, "agent", "hi back", "progress");
    const msgs = app.messages.list(session.id, { limit: 10 });
    expect(msgs.length).toBe(2);
    expect(msgs[0].role).toBe("user");
    expect(msgs[0].content).toBe("hello");
    expect(msgs[1].role).toBe("agent");
    expect(msgs[1].type).toBe("progress");
  });

  it("getMessages respects limit", () => {
    const app = getApp();
    const session = startSession(app, { summary: "msg-limit", repo: "test", flow: "bare", workdir: "/tmp" });
    for (let i = 0; i < 10; i++) {
      app.messages.send(session.id, "user", `msg ${i}`);
    }
    const msgs = app.messages.list(session.id, { limit: 3 });
    expect(msgs.length).toBe(3);
  });

  it("switching sessionId does not show stale messages", () => {
    const app = getApp();
    const s1 = startSession(app, { summary: "stale-1", repo: "test", flow: "bare", workdir: "/tmp" });
    const s2 = startSession(app, { summary: "stale-2", repo: "test", flow: "bare", workdir: "/tmp" });
    app.messages.send(s1.id, "user", "msg for s1");
    app.messages.send(s2.id, "user", "msg for s2");

    // Simulate what the hook does: load messages for s1, then switch to s2
    const msgs1 = app.messages.list(s1.id, { limit: 30 });
    expect(msgs1.length).toBe(1);
    expect(msgs1[0].content).toBe("msg for s1");

    const msgs2 = app.messages.list(s2.id, { limit: 30 });
    expect(msgs2.length).toBe(1);
    expect(msgs2[0].content).toBe("msg for s2");
    // Ensure s2 messages don't contain s1 content
    expect(msgs2[0].content).not.toBe("msg for s1");
  });

  it("messages from multiple sessions stay separate", () => {
    const app = getApp();
    const s1 = startSession(app, { summary: "s1", repo: "test", flow: "bare", workdir: "/tmp" });
    const s2 = startSession(app, { summary: "s2", repo: "test", flow: "bare", workdir: "/tmp" });
    app.messages.send(s1.id, "user", "for s1");
    app.messages.send(s2.id, "user", "for s2");
    expect(app.messages.list(s1.id, { limit: 10 }).length).toBe(1);
    expect(app.messages.list(s2.id, { limit: 10 }).length).toBe(1);
    expect(app.messages.list(s1.id, { limit: 10 })[0].content).toBe("for s1");
  });
});
