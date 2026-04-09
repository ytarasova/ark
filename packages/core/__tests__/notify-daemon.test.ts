import { describe, it, expect, afterEach } from "bun:test";
import { NotifyDaemon } from "../notify-daemon.js";
import { Bridge } from "../bridge.js";
import { withTestContext } from "./test-helpers.js";
import { getApp } from "../app.js";

withTestContext();

describe("NotifyDaemon", () => {
  let daemon: NotifyDaemon | null = null;
  afterEach(() => { daemon?.stop(); daemon = null; });

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
    const bridge = new Bridge({});
    daemon = new NotifyDaemon(getApp(), bridge, {
      activeIntervalMs: 50,
      waitingIntervalMs: 50,
      idleIntervalMs: 50,
    });

    // Create sessions in various states
    const s1 = getApp().sessions.create({ summary: "running-test" });
    getApp().sessions.update(s1.id, { status: "running" });
    const s2 = getApp().sessions.create({ summary: "waiting-test" });
    getApp().sessions.update(s2.id, { status: "waiting" });

    daemon.start();
    // Let it poll once
    await new Promise(r => setTimeout(r, 100));
    daemon.stop();
  });

  it("detects status transitions on subsequent polls", async () => {
    const notifications: string[] = [];
    const bridge = new Bridge({});
    // Override notify to track calls
    bridge.notify = async (text: string) => { notifications.push(text); };

    daemon = new NotifyDaemon(getApp(), bridge, {
      activeIntervalMs: 30,
      waitingIntervalMs: 30,
      idleIntervalMs: 30,
    });

    const s = getApp().sessions.create({ summary: "transition-test" });
    getApp().sessions.update(s.id, { status: "running" });

    daemon.start();
    // First poll establishes baseline
    await new Promise(r => setTimeout(r, 60));

    // Now transition to waiting — next poll should notify
    getApp().sessions.update(s.id, { status: "waiting" });
    await new Promise(r => setTimeout(r, 60));

    daemon.stop();
    // Should have at least one notification about the transition
    expect(notifications.length).toBeGreaterThanOrEqual(1);
    expect(notifications.some(n => n.includes("transition-test"))).toBe(true);
  });

  it("does not notify on initial poll (no previous status)", async () => {
    const notifications: string[] = [];
    const bridge = new Bridge({});
    bridge.notify = async (text: string) => { notifications.push(text); };

    daemon = new NotifyDaemon(getApp(), bridge, {
      activeIntervalMs: 30,
      waitingIntervalMs: 30,
      idleIntervalMs: 30,
    });

    getApp().sessions.create({ summary: "no-initial-notify" });

    daemon.start();
    await new Promise(r => setTimeout(r, 60));
    daemon.stop();

    // No transitions detected on first poll
    expect(notifications.length).toBe(0);
  });
});
