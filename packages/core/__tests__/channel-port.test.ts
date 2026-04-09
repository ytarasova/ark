import { describe, it, expect } from "bun:test";
import { startSession } from "../services/session-orchestration.js";
import { getApp } from "../app.js";
import { withTestContext } from "./test-helpers.js";

withTestContext();

describe("sessionChannelPort", () => {
  it("returns a number in valid range (19200-29199)", () => {
    const port = getApp().sessions.channelPort("s-abc123");
    expect(port).toBeGreaterThanOrEqual(19200);
    expect(port).toBeLessThan(29200);
  });

  it("different session IDs produce different ports (100 random IDs)", () => {
    const ports = new Set<number>();
    for (let i = 0; i < 100; i++) {
      const id = `s-${Math.random().toString(16).slice(2, 10)}`;
      ports.add(getApp().sessions.channelPort(id));
    }
    // With 10000-port range and 100 IDs, collisions should be very rare
    expect(ports.size).toBeGreaterThan(90);
  });

  it("is deterministic (same ID = same port)", () => {
    const id = "s-deadbeef";
    expect(getApp().sessions.channelPort(id)).toBe(getApp().sessions.channelPort(id));
  });
});

describe("isChannelPortAvailable", () => {
  it("returns true when no running sessions use the port", () => {
    const port = getApp().sessions.channelPort("s-aaa111");
    expect(getApp().sessions.isChannelPortAvailable(port)).toBe(true);
  });

  it("returns false when a running session uses the port", () => {
    const session = startSession(getApp(), { summary: "port-test", repo: "test", flow: "bare", workdir: "/tmp" });
    const port = getApp().sessions.channelPort(session.id);
    // startSession creates a session with status 'pending', update to 'running'

    getApp().sessions.update(session.id, { status: "running" });
    expect(getApp().sessions.isChannelPortAvailable(port)).toBe(false);
  });

  it("returns true when excludeSessionId matches the running session", () => {
    const session = startSession(getApp(), { summary: "port-exclude", repo: "test", flow: "bare", workdir: "/tmp" });
    const port = getApp().sessions.channelPort(session.id);

    getApp().sessions.update(session.id, { status: "running" });
    expect(getApp().sessions.isChannelPortAvailable(port, session.id)).toBe(true);
  });
});
