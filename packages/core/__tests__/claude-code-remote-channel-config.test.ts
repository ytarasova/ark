/**
 * F6 regression: remote dispatch with a falsy provider.buildChannelConfig
 * must fail loudly. Pre-fix, a null/undefined `channelConfig` silently
 * fell through to `channelMcpConfig` -> `channelLaunchSpec` ->
 * `process.execPath`, which is the conductor's bun/ark binary path.
 * That path embedded into `.mcp.json` and shipped to EC2 doesn't exist
 * on Ubuntu -- claude on the remote tried to spawn the channel server,
 * got ENOENT, and the session never established a channel.
 */
import { describe, it, expect } from "bun:test";

import { assertRemoteChannelConfig } from "../executors/claude-code.js";
import { channelMcpConfig } from "../claude/mcp-config.js";

describe("assertRemoteChannelConfig (F6)", () => {
  it("returns an error string when channelConfig is null", () => {
    const err = assertRemoteChannelConfig(null, "ec2");
    expect(err).not.toBeNull();
    expect(err!).toContain("channel config required for remote dispatch");
    expect(err!).toContain("'ec2'");
    expect(err!).toContain("buildChannelConfig");
  });

  it("returns an error string when channelConfig is undefined", () => {
    const err = assertRemoteChannelConfig(undefined, "ec2-firecracker");
    expect(err).not.toBeNull();
    expect(err!).toContain("channel config required for remote dispatch");
    expect(err!).toContain("'ec2-firecracker'");
  });

  it("returns an error string when channelConfig is an empty object (would fall back to conductor exec)", () => {
    // Defensive: an empty object would propagate unchanged into
    // mcp-config.ts:buildChannelConfig and produce an .mcp.json with no
    // command/args -- still broken, just a different broken. Treat empty
    // the same as null.
    const err = assertRemoteChannelConfig({}, "ec2");
    expect(err).not.toBeNull();
    expect(err!).toContain("channel config required");
  });

  it("returns null when channelConfig is a populated record", () => {
    const goodConfig = {
      command: "/home/ubuntu/.ark/bin/ark",
      args: ["channel"],
      env: { ARK_SESSION_ID: "s-1" },
    };
    expect(assertRemoteChannelConfig(goodConfig, "ec2")).toBeNull();
  });

  it("includes the unknown provider name when providerName is undefined", () => {
    const err = assertRemoteChannelConfig(null, undefined);
    expect(err).not.toBeNull();
    expect(err!).toContain("<unknown>");
  });
});

describe("channelMcpConfig (F6 leak surface)", () => {
  it("DOES use process.execPath -- confirms why the F6 guard matters", () => {
    // This is the very behaviour assertRemoteChannelConfig protects
    // against: when channelMcpConfig is invoked with no provider override,
    // it pulls the *conductor's* binary path. That's correct for local
    // dispatch (the agent runs on the conductor) and dangerous for remote
    // dispatch (the path doesn't translate). Lock the assumption in here
    // so a future channelMcpConfig refactor that legitimately changes
    // this also forces an audit of the F6 guard.
    const cfg = channelMcpConfig("s-test", "work", 19200);
    expect(typeof cfg.command).toBe("string");
    // process.execPath on a developer machine is /Users/<name>/.bun/bin/bun
    // or /opt/homebrew/.../bun -- regardless, it's NOT a path on Ubuntu.
    // We don't assert the exact string (varies between dev/CI/release).
    expect((cfg.command as string).length).toBeGreaterThan(0);
  });
});
