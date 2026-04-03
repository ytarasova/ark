import { describe, it, expect } from "bun:test";
import { Bridge } from "../bridge.js";
import type { BridgeConfig, BridgeMessage } from "../bridge.js";

describe("Bridge", () => {
  it("constructs without error", () => {
    const bridge = new Bridge({});
    expect(bridge).toBeDefined();
  });

  it("registers message handlers", () => {
    const bridge = new Bridge({});
    const messages: BridgeMessage[] = [];
    bridge.onMessage((msg) => messages.push(msg));
    expect(messages).toHaveLength(0);
  });

  it("notify does nothing without config", async () => {
    const bridge = new Bridge({});
    // Should not throw
    await bridge.notify("test message");
  });

  it("notifySessionStatus formats correctly", async () => {
    // Mock to capture the notification text
    let sentText = "";
    const bridge = new Bridge({});
    // Override notify to capture text
    bridge.notify = async (text: string) => { sentText = text; };

    await bridge.notifySessionStatus(
      { id: "s-1", status: "running", summary: "My task" } as any,
      "pending",
      "running",
    );
    expect(sentText).toContain("My task");
    expect(sentText).toContain("pending \u2192 running");
  });

  it("notifySessionStatus uses id when no summary", async () => {
    let sentText = "";
    const bridge = new Bridge({});
    bridge.notify = async (text: string) => { sentText = text; };

    await bridge.notifySessionStatus(
      { id: "s-42", status: "failed" } as any,
      "running",
      "failed",
    );
    expect(sentText).toContain("s-42");
    expect(sentText).toContain("running \u2192 failed");
  });

  it("start and stop without config is safe", () => {
    const bridge = new Bridge({});
    bridge.start();
    bridge.stop();
    // Should not throw
  });

  it("stop is idempotent", () => {
    const bridge = new Bridge({});
    bridge.stop();
    bridge.stop();
    // Should not throw
  });

  it("start is idempotent", () => {
    const bridge = new Bridge({
      telegram: { botToken: "fake", chatId: "123" },
    });
    bridge.start();
    bridge.start(); // second call should be a no-op
    bridge.stop();
  });
});
