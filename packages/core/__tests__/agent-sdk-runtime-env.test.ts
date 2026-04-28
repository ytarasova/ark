/**
 * Pin the agent-sdk runtime YAML -> child env-var projection.
 *
 * Built-in SDK subagents (Explore etc.) cannot be reconfigured via the
 * SDK's `agents` option (the docs are explicit). The escape hatch is
 * `ANTHROPIC_DEFAULT_HAIKU_MODEL`, which the bundled claude binary reads.
 * The executor reads `default_haiku_model` from the agent-sdk runtime
 * YAML and forwards it as that env var to the spawned launch.ts.
 *
 * This test pins both the happy path and the absence path so the SDK
 * default isn't accidentally clobbered when the YAML omits the field.
 */

import { describe, it, expect } from "bun:test";
import { buildAgentSdkRuntimeEnv } from "../executors/agent-sdk.js";

describe("buildAgentSdkRuntimeEnv", () => {
  it("forwards default_haiku_model as ANTHROPIC_DEFAULT_HAIKU_MODEL", () => {
    const env = buildAgentSdkRuntimeEnv({
      default_haiku_model: "pi-agentic/global.anthropic.claude-haiku-4-5",
    });
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("pi-agentic/global.anthropic.claude-haiku-4-5");
  });

  it("omits ANTHROPIC_DEFAULT_HAIKU_MODEL when YAML doesn't set the field", () => {
    const env = buildAgentSdkRuntimeEnv({ compat: ["bedrock"] });
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBeUndefined();
  });

  it("ignores empty / non-string default_haiku_model so we don't ship junk to the bundled binary", () => {
    expect(buildAgentSdkRuntimeEnv({ default_haiku_model: "" }).ANTHROPIC_DEFAULT_HAIKU_MODEL).toBeUndefined();
    expect(buildAgentSdkRuntimeEnv({ default_haiku_model: 42 }).ANTHROPIC_DEFAULT_HAIKU_MODEL).toBeUndefined();
    expect(buildAgentSdkRuntimeEnv({ default_haiku_model: null }).ANTHROPIC_DEFAULT_HAIKU_MODEL).toBeUndefined();
  });

  it("still projects the `compat` modes alongside the haiku override", () => {
    const env = buildAgentSdkRuntimeEnv({
      compat: ["bedrock", ""],
      default_haiku_model: "pi-agentic/global.anthropic.claude-haiku-4-5",
    });
    expect(env.ARK_COMPAT).toBe("bedrock");
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("pi-agentic/global.anthropic.claude-haiku-4-5");
  });

  it("returns an empty object for null / undefined runtime def (no YAML loaded)", () => {
    expect(buildAgentSdkRuntimeEnv(null)).toEqual({});
    expect(buildAgentSdkRuntimeEnv(undefined)).toEqual({});
  });
});
