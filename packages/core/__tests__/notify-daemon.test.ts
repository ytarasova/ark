import { describe, it, expect, afterEach } from "bun:test";
import { NotifyDaemon } from "../infra/notify-daemon.js";
import { Bridge } from "../integrations/bridge.js";
import { withTestContext, waitFor } from "./test-helpers.js";
import { getApp } from "./test-helpers.js";

withTestContext();

describe("NotifyDaemon", async () => {
  let daemon: NotifyDaemon | null = null;
  afterEach(() => {
    daemon?.stop();
    daemon = null;
  });

  it("constructs without error", () => {
    const bridge = new Bridge({});
    daemon = new NotifyDaemon(getApp(), bridge);
    expect(daemon).toBeDefined();
  });

  it("start and stop are safe", () => {
    const bridge = new Bridge({});
    daemon = new NotifyDaemon(getApp(), bridge);
    daemon.start();
    daemon.stop();
  });

  it("stop is idempotent", () => {
    const bridge = new Bridge({});
    daemon = new NotifyDaemon(getApp(), bridge);
    daemon.stop();
    daemon.stop();
  });

  it("start is idempotent", () => {
    const bridge = new Bridge({});
    daemon = new NotifyDaemon(getApp(), bridge);
    daemon.start();
    daemon.start();
    daemon.stop();
  });

  it("accepts custom polling intervals", () => {
    const bridge = new Bridge({});
    daemon = new NotifyDaemon(getApp(), bridge, {
      activeIntervalMs: 1000,
      waitingIntervalMs: 5000,
      idleIntervalMs: 15000,
    });
    expect(daemon).toBeDefined();
    daemon.start();
    daemon.stop();
  });

  it("polls sessions without crashing when sessions exist", async () => {
    let polls = 0;
    const bridge = new Bridge({});
    daemon = new NotifyDaemon(getApp(), bridge, {
      activeIntervalMs: 20,
      waitingIntervalMs: 20,
      idleIntervalMs: 20,
      onPoll: () => {
        polls++;
      },
    });

    const s1 = await getApp().sessions.create({ summary: "running-test" });
    await getApp().sessions.update(s1.id, { status: "running" });
    const s2 = await getApp().sessions.create({ summary: "waiting-test" });
    await getApp().sessions.update(s2.id, { status: "waiting" });

    daemon.start();
    await waitFor(() => polls >= 1, { timeout: 2000, message: "expected at least one poll" });
    daemon.stop();
  });

  it("detects status transitions on subsequent polls", async () => {
    const notifications: string[] = [];
    const bridge = new Bridge({});
    bridge.notify = async (text: string) => {
      notifications.push(text);
    };

    let polls = 0;
    daemon = new NotifyDaemon(getApp(), bridge, {
      activeIntervalMs: 20,
      waitingIntervalMs: 20,
      idleIntervalMs: 20,
      onPoll: () => {
        polls++;
      },
    });

    const s = await getApp().sessions.create({ summary: "transition-test" });
    await getApp().sessions.update(s.id, { status: "running" });

    daemon.start();
    // Wait for the baseline poll to land
    await waitFor(() => polls >= 1, { timeout: 2000 });

    // Transition -> wait until at least one more poll observes it
    await getApp().sessions.update(s.id, { status: "waiting" });
    await waitFor(() => notifications.some((n) => n.includes("transition-test")), {
      timeout: 2000,
      message: "expected a transition notification",
    });

    daemon.stop();
    expect(notifications.length).toBeGreaterThanOrEqual(1);
  });

  it("does not notify on initial poll (no previous status)", async () => {
    const notifications: string[] = [];
    const bridge = new Bridge({});
    bridge.notify = async (text: string) => {
      notifications.push(text);
    };

    let polls = 0;
    daemon = new NotifyDaemon(getApp(), bridge, {
      activeIntervalMs: 20,
      waitingIntervalMs: 20,
      idleIntervalMs: 20,
      onPoll: () => {
        polls++;
      },
    });

    await getApp().sessions.create({ summary: "no-initial-notify" });

    daemon.start();
    await waitFor(() => polls >= 1, { timeout: 2000 });
    daemon.stop();

    expect(notifications.length).toBe(0);
  });
});
