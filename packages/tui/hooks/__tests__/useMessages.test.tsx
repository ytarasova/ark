import { describe, it, expect } from "bun:test";
import * as core from "../../../core/index.js";
import { withTestContext } from "../../../core/__tests__/test-helpers.js";

withTestContext();

describe("useMessages internals", () => {
  it("getMessages returns stored messages", () => {
    const session = core.startSession({ summary: "msg-test", repo: "test", flow: "bare", workdir: "/tmp" });
    core.addMessage({ session_id: session.id, role: "user", content: "hello" });
    core.addMessage({ session_id: session.id, role: "agent", content: "hi back", type: "progress" });
    const msgs = core.getMessages(session.id, { limit: 10 });
    expect(msgs.length).toBe(2);
    expect(msgs[0].role).toBe("user");
    expect(msgs[0].content).toBe("hello");
    expect(msgs[1].role).toBe("agent");
    expect(msgs[1].type).toBe("progress");
  });

  it("getMessages respects limit", () => {
    const session = core.startSession({ summary: "msg-limit", repo: "test", flow: "bare", workdir: "/tmp" });
    for (let i = 0; i < 10; i++) {
      core.addMessage({ session_id: session.id, role: "user", content: `msg ${i}` });
    }
    const msgs = core.getMessages(session.id, { limit: 3 });
    expect(msgs.length).toBe(3);
  });

  it("messages from multiple sessions stay separate", () => {
    const s1 = core.startSession({ summary: "s1", repo: "test", flow: "bare", workdir: "/tmp" });
    const s2 = core.startSession({ summary: "s2", repo: "test", flow: "bare", workdir: "/tmp" });
    core.addMessage({ session_id: s1.id, role: "user", content: "for s1" });
    core.addMessage({ session_id: s2.id, role: "user", content: "for s2" });
    expect(core.getMessages(s1.id, { limit: 10 }).length).toBe(1);
    expect(core.getMessages(s2.id, { limit: 10 }).length).toBe(1);
    expect(core.getMessages(s1.id, { limit: 10 })[0].content).toBe("for s1");
  });
});
