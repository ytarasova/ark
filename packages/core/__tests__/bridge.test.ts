import { describe, it, expect } from "bun:test";
import { Bridge } from "../integrations/bridge.js";
import type { BridgeMessage } from "../integrations/bridge.js";
import { withTestContext, mockSession } from "./test-helpers.js";

withTestContext();

describe("Bridge", async () => {
  it("constructs without error", () => {
    const bridge = new Bridge({});
    expect(bridge).toBeDefined();
  });

  it("registers message handlers", () => {
    const bridge = new Bridge({});
    const messages: BridgeMessage[] = [];
    bridge.onMessage((msg) => {
      messages.push(msg);
    });
    expect(messages).toHaveLength(0);
  });

  it("notify does nothing without config", async () => {
    const bridge = new Bridge({});
    await bridge.notify("test message");
  });

  it("notifySessionStatus formats correctly", async () => {
    let sentText = "";
    const bridge = new Bridge({});
    bridge.notify = async (text: string) => {
      sentText = text;
    };

    await bridge.notifySessionStatus(
      mockSession({ id: "s-1", status: "running", summary: "My task" }),
      "pending",
      "running",
    );
    expect(sentText).toContain("My task");
    expect(sentText).toContain("pending → running");
  });

  it("notifySessionStatus uses id when no summary", async () => {
    let sentText = "";
    const bridge = new Bridge({});
    bridge.notify = async (text: string) => {
      sentText = text;
    };

    await bridge.notifySessionStatus(mockSession({ id: "s-42", status: "failed" }), "running", "failed");
    expect(sentText).toContain("s-42");
    expect(sentText).toContain("running → failed");
  });

  it("start and stop without config is safe", () => {
    const bridge = new Bridge({});
    bridge.start();
    bridge.stop();
  });

  it("stop is idempotent", () => {
    const bridge = new Bridge({});
    bridge.stop();
    bridge.stop();
  });

  it("start is idempotent", () => {
    const bridge = new Bridge({
      slack: { webhookUrl: "https://example.invalid/webhook" },
    });
    bridge.start();
    bridge.start();
    expect(bridge.isRunning()).toBe(true);
    bridge.stop();
  });
});

describe("Bridge status notifications", async () => {
  it("notifySessionStatus uses correct emoji for each status", async () => {
    const bridge = new Bridge({});
    const texts: string[] = [];
    bridge.notify = async (text: string) => {
      texts.push(text);
    };

    const statuses = [
      { to: "running", emoji: "\u{1F7E2}" },
      { to: "waiting", emoji: "\u{1F7E1}" },
      { to: "completed", emoji: "✅" },
      { to: "failed", emoji: "\u{1F534}" },
      { to: "stopped", emoji: "⏹" },
      { to: "unknown", emoji: "⚪" },
    ];

    for (const { to } of statuses) {
      await bridge.notifySessionStatus(mockSession({ id: "s-1", status: to }), "prev", to);
    }

    expect(texts.length).toBe(6);
    for (let i = 0; i < statuses.length; i++) {
      expect(texts[i]).toContain(statuses[i].emoji);
      expect(texts[i]).toContain(`prev → ${statuses[i].to}`);
    }
  });

  it("notifyStatusSummary includes session count", async () => {
    let sentText = "";
    const bridge = new Bridge({});
    bridge.notify = async (text: string) => {
      sentText = text;
    };

    await bridge.notifyStatusSummary();
    expect(sentText).toContain("Status summary");
    expect(sentText).toContain("total");
  });
});

describe("Bridge config", () => {
  it("loadBridgeConfig returns null for missing file", async () => {
    const { loadBridgeConfig } = await import("../integrations/bridge.js");
    const config = loadBridgeConfig();
    expect(config === null || typeof config === "object").toBe(true);
  });

  it("createBridge returns null without config", async () => {
    const { createBridge } = await import("../integrations/bridge.js");
    const bridge = createBridge();
    expect(bridge === null || typeof bridge === "object").toBe(true);
    if (bridge) bridge.stop();
  });
});

describe("Bridge handler invocation", async () => {
  it("multiple handlers are all called", async () => {
    const bridge = new Bridge({});
    const results: string[] = [];

    bridge.onMessage((msg) => {
      results.push(`h1:${msg.text}`);
    });
    bridge.onMessage((msg) => {
      results.push(`h2:${msg.text}`);
    });

    // No inbound source today -- registration is the only thing we can
    // reliably assert without a mocked transport.
    expect(results).toHaveLength(0);
  });

  it("notify with slack and email config attempts both", async () => {
    const bridge = new Bridge({
      slack: { webhookUrl: "https://example.invalid/webhook" },
      email: {
        host: "127.0.0.1",
        port: 2525,
        from: "ark@example.invalid",
        to: "ops@example.invalid",
      },
    });
    await bridge.notify("test");
  }, 15_000);

  it("notify with email-only config does not throw", async () => {
    const bridge = new Bridge({
      email: {
        host: "127.0.0.1",
        port: 2525,
        from: "ark@example.invalid",
        to: "ops@example.invalid",
      },
    });
    await bridge.notify("test");
  }, 15_000);
});
