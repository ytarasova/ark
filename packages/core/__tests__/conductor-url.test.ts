/**
 * Tests for conductor URL propagation through the channel config pipeline.
 */

import { describe, it, expect } from "bun:test";
import { channelMcpConfig } from "../claude/claude.js";

describe("channelMcpConfig", () => {
  it("defaults conductor URL to localhost:19100", () => {
    const config = channelMcpConfig("s-abc", "work", 19200);
    const env = config.env as Record<string, string>;
    expect(env.ARK_CONDUCTOR_URL).toBe("http://localhost:19100");
    expect(env.ARK_SESSION_ID).toBe("s-abc");
    expect(env.ARK_CHANNEL_PORT).toBe("19200");
  });

  it("passes custom conductor URL for devcontainer", () => {
    const config = channelMcpConfig("s-abc", "work", 19200, {
      conductorUrl: "http://host.docker.internal:19100",
    });
    const env = config.env as Record<string, string>;
    expect(env.ARK_CONDUCTOR_URL).toBe("http://host.docker.internal:19100");
  });

  it("passes custom conductor URL for remote", () => {
    const config = channelMcpConfig("s-abc", "work", 19200, {
      conductorUrl: "http://localhost:19100",
    });
    const env = config.env as Record<string, string>;
    expect(env.ARK_CONDUCTOR_URL).toBe("http://localhost:19100");
  });
});
