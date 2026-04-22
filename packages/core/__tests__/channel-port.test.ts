import { describe, it, expect } from "bun:test";
import { withTestContext } from "./test-helpers.js";
import { getApp } from "./test-helpers.js";

withTestContext();

describe("sessionChannelPort", () => {
  it("returns a number in the configured range", () => {
    const { basePort, range } = getApp().config.channels;
    const port = getApp().sessions.channelPort("s-abc123");
    expect(port).toBeGreaterThanOrEqual(basePort);
    expect(port).toBeLessThan(basePort + range);
  });

  it("different session IDs produce different ports (100 random IDs)", () => {
    const ports = new Set<number>();
    for (let i = 0; i < 100; i++) {
      const id = `s-${Math.random().toString(16).slice(2, 10)}`;
      ports.add(getApp().sessions.channelPort(id));
    }
    // With a range of >=1000 ports and 100 IDs, collisions are rare.
    // Conservative threshold so the test-profile 1000-port range also passes.
    expect(ports.size).toBeGreaterThan(80);
  });

  it("is deterministic (same ID = same port)", () => {
    const id = "s-deadbeef";
    expect(getApp().sessions.channelPort(id)).toBe(getApp().sessions.channelPort(id));
  });
});

describe("isChannelPortAvailable", async () => {
  it("returns true when no running sessions use the port", async () => {
    const port = getApp().sessions.channelPort("s-aaa111");
    expect(await getApp().sessions.isChannelPortAvailable(port)).toBe(true);
  });

  it("returns false when a running session uses the port", async () => {
    const session = await getApp().sessionLifecycle.start({
      summary: "port-test",
      repo: "test",
      flow: "bare",
      workdir: "/tmp",
    });
    const port = getApp().sessions.channelPort(session.id);
    // startSession creates a session with status 'pending', update to 'running'

    await getApp().sessions.update(session.id, { status: "running" });
    expect(await getApp().sessions.isChannelPortAvailable(port)).toBe(false);
  });

  it("returns true when excludeSessionId matches the running session", async () => {
    const session = await getApp().sessionLifecycle.start({
      summary: "port-exclude",
      repo: "test",
      flow: "bare",
      workdir: "/tmp",
    });
    const port = getApp().sessions.channelPort(session.id);

    await getApp().sessions.update(session.id, { status: "running" });
    expect(await getApp().sessions.isChannelPortAvailable(port, session.id)).toBe(true);
  });
});
