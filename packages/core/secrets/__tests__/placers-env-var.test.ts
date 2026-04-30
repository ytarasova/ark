import { describe, expect, test } from "bun:test";
import { envVarPlacer } from "../placers/env-var.js";
import { MockPlacementCtx } from "./mock-placement-ctx.js";

describe("envVarPlacer", () => {
  test("calls setEnv with name + value", async () => {
    const ctx = new MockPlacementCtx();
    await envVarPlacer.place(
      { name: "ANTHROPIC_API_KEY", type: "env-var", metadata: {}, value: "sk-ant-xxx" },
      ctx,
    );
    const setEnvCalls = ctx.calls.filter(c => c.kind === "setEnv");
    expect(setEnvCalls).toEqual([
      { kind: "setEnv", key: "ANTHROPIC_API_KEY", value: "sk-ant-xxx" },
    ]);
  });

  test("throws when value is missing", async () => {
    const ctx = new MockPlacementCtx();
    await expect(
      envVarPlacer.place({ name: "FOO", type: "env-var", metadata: {} }, ctx),
    ).rejects.toThrow();
  });

  test("type field is env-var", () => {
    expect(envVarPlacer.type).toBe("env-var");
  });
});
