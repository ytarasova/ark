/**
 * Pin the agent-sdk runtime YAML -> child env-var projection.
 *
 * Built-in SDK subagents (Explore etc.) cannot be reconfigured via the
 * SDK's `agents` option (the docs are explicit). The escape hatch is
 * `ANTHROPIC_DEFAULT_HAIKU_MODEL`, which the bundled claude binary reads.
 * The executor reads `runtime_config.claude-agent.default_haiku_model`
 * from the runtime YAML and forwards it as that env var to launch.ts.
 *
 * The field lives under `runtime_config` -- not at the top level of
 * RuntimeDefinition -- so runtime-specific knobs don't leak into the
 * generic interface shape.
 *
 * This test pins both the happy path and the absence path so the SDK
 * default isn't accidentally clobbered when the YAML omits the field.
 */

import { describe, it, expect } from "bun:test";
import { buildAgentSdkRuntimeEnv } from "../executors/claude-agent.js";

const HAIKU_OVERRIDE = "pi-agentic/global.anthropic.claude-haiku-4-5";

describe("buildAgentSdkRuntimeEnv", () => {
  it("forwards runtime_config.claude-agent.default_haiku_model as ANTHROPIC_DEFAULT_HAIKU_MODEL", () => {
    const env = buildAgentSdkRuntimeEnv({
      runtime_config: { "claude-agent": { default_haiku_model: HAIKU_OVERRIDE } },
    });
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe(HAIKU_OVERRIDE);
  });

  it("omits ANTHROPIC_DEFAULT_HAIKU_MODEL when YAML doesn't set the field", () => {
    const env = buildAgentSdkRuntimeEnv({ compat: ["bedrock"] });
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBeUndefined();
  });

  it("ignores empty / non-string default_haiku_model so we don't ship junk to the bundled binary", () => {
    expect(
      buildAgentSdkRuntimeEnv({ runtime_config: { "claude-agent": { default_haiku_model: "" } } })
        .ANTHROPIC_DEFAULT_HAIKU_MODEL,
    ).toBeUndefined();
    expect(
      buildAgentSdkRuntimeEnv({ runtime_config: { "claude-agent": { default_haiku_model: 42 } } })
        .ANTHROPIC_DEFAULT_HAIKU_MODEL,
    ).toBeUndefined();
    expect(
      buildAgentSdkRuntimeEnv({ runtime_config: { "claude-agent": { default_haiku_model: null } } })
        .ANTHROPIC_DEFAULT_HAIKU_MODEL,
    ).toBeUndefined();
  });

  it("ignores top-level default_haiku_model (legacy shape removed)", () => {
    // Pre-#480 shape kept the field at the top level. After the runtime_config
    // refactor it's no longer read, so a stray legacy YAML doesn't accidentally
    // smuggle the override past the type system.
    const env = buildAgentSdkRuntimeEnv({ default_haiku_model: HAIKU_OVERRIDE });
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBeUndefined();
  });

  it("still projects the `compat` modes alongside the haiku override", () => {
    const env = buildAgentSdkRuntimeEnv({
      compat: ["bedrock", ""],
      runtime_config: { "claude-agent": { default_haiku_model: HAIKU_OVERRIDE } },
    });
    expect(env.ARK_COMPAT).toBe("bedrock");
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe(HAIKU_OVERRIDE);
  });

  it("ignores foreign runtime_config blocks -- only reads its own type", () => {
    const env = buildAgentSdkRuntimeEnv({
      runtime_config: {
        goose: { recipe: "noise.yaml" },
        "claude-code": { default_haiku_model: "should-be-ignored" },
      },
    });
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBeUndefined();
  });

  it("returns an empty object for null / undefined runtime def (no YAML loaded)", () => {
    expect(buildAgentSdkRuntimeEnv(null)).toEqual({});
    expect(buildAgentSdkRuntimeEnv(undefined)).toEqual({});
  });
});
