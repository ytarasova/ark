import { describe, expect, test } from "bun:test";
import { NoopPlacementCtx } from "../noop-placement-ctx.js";

describe("NoopPlacementCtx", () => {
  test("setEnv works (env always works on every provider)", () => {
    const ctx = new NoopPlacementCtx("k8s");
    ctx.setEnv("FOO", "v");
    expect(ctx.getEnv()).toEqual({ FOO: "v" });
  });

  test("writeFile is a no-op", async () => {
    const ctx = new NoopPlacementCtx("k8s");
    await expect(ctx.writeFile("/x", 0o600, new Uint8Array())).resolves.toBeUndefined();
  });

  test("expandHome substitutes ~/ with the home root", () => {
    const ctx = new NoopPlacementCtx("local", "/Users/yana");
    expect(ctx.expandHome("~/foo")).toBe("/Users/yana/foo");
    expect(ctx.expandHome("/abs")).toBe("/abs");
  });
});
