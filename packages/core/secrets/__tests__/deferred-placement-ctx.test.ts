/**
 * Unit tests for DeferredPlacementCtx -- the two-phase placement helper that
 * lets the dispatcher run env placement pre-launch while deferring file
 * placement until the provider's medium (SSH connection, IP, ...) is ready.
 *
 * The contract under test:
 *   - setEnv lands SYNCHRONOUSLY (so the dispatcher's pre-launch
 *     `Object.assign(env, ctx.getEnv())` is correct).
 *   - writeFile / appendFile / setProvisionerConfig are queued, not executed.
 *   - flush(target) replays the queued ops in order onto a real ctx.
 *   - hasDeferred() reports whether there's anything to flush.
 *   - expandHome respects the homeRoot constructor arg (default
 *     "/home/ubuntu" because the EC2 family is the only current consumer).
 */

import { describe, it, expect } from "bun:test";
import { DeferredPlacementCtx } from "../deferred-placement-ctx.js";
import { MockPlacementCtx } from "./mock-placement-ctx.js";

describe("DeferredPlacementCtx", () => {
  it("captures setEnv synchronously", () => {
    const ctx = new DeferredPlacementCtx();
    ctx.setEnv("TOKEN", "abc");
    ctx.setEnv("OTHER", "xyz");
    expect(ctx.getEnv()).toEqual({ TOKEN: "abc", OTHER: "xyz" });
  });

  it("queues writeFile without executing", async () => {
    const ctx = new DeferredPlacementCtx();
    await ctx.writeFile("/home/ubuntu/.ssh/id_rsa", 0o600, new Uint8Array([1, 2, 3]));
    expect(ctx.hasDeferred()).toBe(true);
    expect(ctx.queuedOps).toHaveLength(1);
    expect(ctx.queuedOps[0]).toMatchObject({
      kind: "writeFile",
      path: "/home/ubuntu/.ssh/id_rsa",
      mode: 0o600,
    });
  });

  it("queues appendFile without executing", async () => {
    const ctx = new DeferredPlacementCtx();
    await ctx.appendFile("/home/ubuntu/.ssh/config", "ark:secret:KEY", new Uint8Array([4, 5]));
    expect(ctx.queuedOps).toHaveLength(1);
    expect(ctx.queuedOps[0]).toMatchObject({
      kind: "appendFile",
      path: "/home/ubuntu/.ssh/config",
      marker: "ark:secret:KEY",
    });
  });

  it("queues setProvisionerConfig", () => {
    const ctx = new DeferredPlacementCtx();
    ctx.setProvisionerConfig({ kubeconfig: new Uint8Array([7]) });
    expect(ctx.queuedOps).toHaveLength(1);
    expect(ctx.queuedOps[0].kind).toBe("setProvisionerConfig");
  });

  it("hasDeferred is false when only env was set", () => {
    const ctx = new DeferredPlacementCtx();
    ctx.setEnv("X", "y");
    expect(ctx.hasDeferred()).toBe(false);
  });

  it("expandHome uses default /home/ubuntu", () => {
    const ctx = new DeferredPlacementCtx();
    expect(ctx.expandHome("~/.ssh/config")).toBe("/home/ubuntu/.ssh/config");
    expect(ctx.expandHome("/abs/path")).toBe("/abs/path");
  });

  it("expandHome respects custom homeRoot", () => {
    const ctx = new DeferredPlacementCtx("/root");
    expect(ctx.expandHome("~/.config")).toBe("/root/.config");
  });

  it("flush replays queued ops in order onto a real ctx", async () => {
    const ctx = new DeferredPlacementCtx();
    const keyBytes = new Uint8Array([1, 2, 3]);
    const cfgBytes = new Uint8Array([4, 5, 6]);
    const khBytes = new Uint8Array([7, 8, 9]);

    await ctx.writeFile("/home/ubuntu/.ssh/id_x", 0o600, keyBytes);
    await ctx.appendFile("/home/ubuntu/.ssh/config", "ark:secret:X", cfgBytes);
    await ctx.appendFile("/home/ubuntu/.ssh/known_hosts", "ark:secret:X", khBytes);

    const target = new MockPlacementCtx();
    await ctx.flush(target);

    expect(target.calls).toHaveLength(3);
    expect(target.calls[0]).toMatchObject({
      kind: "writeFile",
      path: "/home/ubuntu/.ssh/id_x",
      mode: 0o600,
    });
    expect(target.calls[1]).toMatchObject({
      kind: "appendFile",
      path: "/home/ubuntu/.ssh/config",
      marker: "ark:secret:X",
    });
    expect(target.calls[2]).toMatchObject({
      kind: "appendFile",
      path: "/home/ubuntu/.ssh/known_hosts",
      marker: "ark:secret:X",
    });
  });

  it("flush of an empty queue is a no-op", async () => {
    const ctx = new DeferredPlacementCtx();
    ctx.setEnv("ENV_ONLY", "v");
    const target = new MockPlacementCtx();
    await ctx.flush(target);
    expect(target.calls).toHaveLength(0);
  });

  it("flush forwards setProvisionerConfig payload verbatim", async () => {
    const ctx = new DeferredPlacementCtx();
    const kc = new Uint8Array([0xa, 0xb, 0xc]);
    ctx.setProvisionerConfig({ kubeconfig: kc });

    const target = new MockPlacementCtx();
    await ctx.flush(target);

    expect(target.calls).toHaveLength(1);
    const call = target.calls[0] as { kind: "setProvisionerConfig"; cfg: { kubeconfig?: Uint8Array } };
    expect(call.kind).toBe("setProvisionerConfig");
    expect(call.cfg.kubeconfig).toBe(kc);
  });
});
