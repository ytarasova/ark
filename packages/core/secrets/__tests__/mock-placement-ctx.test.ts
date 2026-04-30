import { describe, expect, test } from "bun:test";
import { MockPlacementCtx } from "./mock-placement-ctx.js";

describe("MockPlacementCtx", () => {
  test("records calls in order", async () => {
    const ctx = new MockPlacementCtx();
    await ctx.writeFile("/tmp/x", 0o600, new Uint8Array([1, 2]));
    ctx.setEnv("FOO", "bar");
    expect(ctx.calls).toHaveLength(2);
    expect(ctx.calls[0]).toEqual({ kind: "writeFile", path: "/tmp/x", mode: 0o600, bytes: new Uint8Array([1, 2]) });
    expect(ctx.calls[1]).toEqual({ kind: "setEnv", key: "FOO", value: "bar" });
  });
  test("getEnv returns merged map", () => {
    const ctx = new MockPlacementCtx();
    ctx.setEnv("A", "1");
    ctx.setEnv("B", "2");
    expect(ctx.getEnv()).toEqual({ A: "1", B: "2" });
  });
  test("expandHome substitutes ~/", () => {
    const ctx = new MockPlacementCtx("/home/ubuntu");
    expect(ctx.expandHome("~/.ssh/config")).toBe("/home/ubuntu/.ssh/config");
    expect(ctx.expandHome("/abs/path")).toBe("/abs/path");
  });
});
