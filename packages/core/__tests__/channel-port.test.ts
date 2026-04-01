import { describe, it, expect } from "bun:test";
import { sessionChannelPort, isChannelPortAvailable, startSession } from "../index.js";
import { withTestContext } from "./test-helpers.js";

describe("sessionChannelPort", () => {
  it("returns a number in valid range (19200-29199)", () => {
    const port = sessionChannelPort("s-abc123");
    expect(port).toBeGreaterThanOrEqual(19200);
    expect(port).toBeLessThan(29200);
  });

  it("different session IDs produce different ports (100 random IDs)", () => {
    const ports = new Set<number>();
    for (let i = 0; i < 100; i++) {
      const id = `s-${Math.random().toString(16).slice(2, 10)}`;
      ports.add(sessionChannelPort(id));
    }
    // With 10000-port range and 100 IDs, collisions should be very rare
    expect(ports.size).toBeGreaterThan(90);
  });

  it("is deterministic (same ID = same port)", () => {
    const id = "s-deadbeef";
    expect(sessionChannelPort(id)).toBe(sessionChannelPort(id));
  });
});

describe("isChannelPortAvailable", () => {
  withTestContext();

  it("returns true when no running sessions use the port", () => {
    const port = sessionChannelPort("s-aaa111");
    expect(isChannelPortAvailable(port)).toBe(true);
  });

  it("returns false when a running session uses the port", () => {
    const session = startSession({ summary: "port-test", repo: "test", flow: "bare", workdir: "/tmp" });
    const port = sessionChannelPort(session.id);
    // startSession creates a session with status 'pending', update to 'running'
    const { updateSession } = require("../store.js");
    updateSession(session.id, { status: "running" });
    expect(isChannelPortAvailable(port)).toBe(false);
  });

  it("returns true when excludeSessionId matches the running session", () => {
    const session = startSession({ summary: "port-exclude", repo: "test", flow: "bare", workdir: "/tmp" });
    const port = sessionChannelPort(session.id);
    const { updateSession } = require("../store.js");
    updateSession(session.id, { status: "running" });
    expect(isChannelPortAvailable(port, session.id)).toBe(true);
  });
});
