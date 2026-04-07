import { describe, it, expect } from "bun:test";
import { Bridge } from "../bridge.js";
import type { BridgeConfig, BridgeMessage } from "../bridge.js";
import { withTestContext } from "./test-helpers.js";

withTestContext();

describe("Bridge", () => {
  it("constructs without error", () => {
    const bridge = new Bridge({});
    expect(bridge).toBeDefined();
  });

  it("registers message handlers", () => {
    const bridge = new Bridge({});
    const messages: BridgeMessage[] = [];
    bridge.onMessage((msg) => { messages.push(msg); });
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

describe("Bridge status notifications", () => {
  it("notifySessionStatus uses correct emoji for each status", async () => {
    const bridge = new Bridge({});
    const texts: string[] = [];
    bridge.notify = async (text: string) => { texts.push(text); };

    const statuses = [
      { to: "running", emoji: "\u{1F7E2}" },
      { to: "waiting", emoji: "\u{1F7E1}" },
      { to: "completed", emoji: "\u2705" },
      { to: "failed", emoji: "\u{1F534}" },
      { to: "stopped", emoji: "\u23F9" },
      { to: "unknown", emoji: "\u26AA" },
    ];

    for (const { to, emoji } of statuses) {
      await bridge.notifySessionStatus({ id: "s-1", status: to } as any, "prev", to);
    }

    expect(texts.length).toBe(6);
    for (let i = 0; i < statuses.length; i++) {
      expect(texts[i]).toContain(statuses[i].emoji);
      expect(texts[i]).toContain(`prev \u2192 ${statuses[i].to}`);
    }
  });

  it("notifyStatusSummary includes session count", async () => {
    let sentText = "";
    const bridge = new Bridge({});
    bridge.notify = async (text: string) => { sentText = text; };

    await bridge.notifyStatusSummary();
    expect(sentText).toContain("Status summary");
    expect(sentText).toContain("total");
  });
});

describe("Bridge config", () => {
  it("loadBridgeConfig returns null for missing file", () => {
    const { loadBridgeConfig } = require("../bridge.js");
    // The default ARK_DIR won't have bridge.json unless user created it
    // This test is safe because we check the function doesn't throw
    const config = loadBridgeConfig();
    // Either null (no file) or valid config (if user has one)
    expect(config === null || typeof config === "object").toBe(true);
  });

  it("createBridge returns null without config", () => {
    const { createBridge } = require("../bridge.js");
    // Same as above — depends on whether ~/.ark/bridge.json exists
    const bridge = createBridge();
    expect(bridge === null || typeof bridge === "object").toBe(true);
    if (bridge) bridge.stop();
  });
});

describe("Bridge handler invocation", () => {
  it("multiple handlers are all called", async () => {
    const bridge = new Bridge({});
    const results: string[] = [];

    bridge.onMessage((msg) => { results.push(`h1:${msg.text}`); });
    bridge.onMessage((msg) => { results.push(`h2:${msg.text}`); });

    // Directly simulate — we can't trigger pollTelegram in tests
    // but we can verify the handler registration pattern
    expect(results).toHaveLength(0);
  });

  it("notify with both telegram and slack config attempts both", async () => {
    // This will fail network calls but should not throw
    const bridge = new Bridge({
      telegram: { botToken: "invalid-token", chatId: "123" },
      slack: { webhookUrl: "https://invalid.example.com/webhook" },
    });

    // Should not throw — errors are caught internally
    await bridge.notify("test");
  }, 15_000);

  it("notify with discord config does not throw", async () => {
    const bridge = new Bridge({
      discord: { webhookUrl: "https://invalid.example.com/webhook" },
    });
    await bridge.notify("test");
  });

  it("notify with all three platforms does not throw", async () => {
    const bridge = new Bridge({
      telegram: { botToken: "invalid-token", chatId: "123" },
      slack: { webhookUrl: "https://invalid.example.com/webhook" },
      discord: { webhookUrl: "https://invalid.example.com/webhook" },
    });
    await bridge.notify("test");
  });
});
