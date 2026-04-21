import { describe, it, expect, afterEach } from "bun:test";
import { registerInstance, activeInstanceCount } from "../infra/instance-lock.js";
import { withTestContext } from "./test-helpers.js";
import { getApp } from "./test-helpers.js";

withTestContext();

describe("multi-instance coordination", () => {
  let cleanups: (() => void)[] = [];
  afterEach(() => {
    cleanups.forEach((fn) => fn());
    cleanups = [];
  });

  it("registerInstance creates a heartbeat entry", async () => {
    const inst = await registerInstance(getApp(), "test-1");
    cleanups.push(inst.stop);
    expect(await activeInstanceCount(getApp())).toBe(1);
  });

  it("first registered instance is primary", async () => {
    const inst1 = await registerInstance(getApp(), "inst-a");
    cleanups.push(inst1.stop);
    const inst2 = await registerInstance(getApp(), "inst-b");
    cleanups.push(inst2.stop);
    expect(inst1.isPrimary()).toBe(true);
    expect(inst2.isPrimary()).toBe(false);
  });

  it("stop removes the instance", async () => {
    const inst = await registerInstance(getApp(), "inst-stop");
    inst.stop();
    expect(await activeInstanceCount(getApp())).toBe(0);
  });

  it("multiple instances are counted", async () => {
    const a = await registerInstance(getApp(), "a");
    const b = await registerInstance(getApp(), "b");
    const c = await registerInstance(getApp(), "c");
    cleanups.push(a.stop, b.stop, c.stop);
    expect(await activeInstanceCount(getApp())).toBe(3);
  });

  it("activeInstanceCount returns 0 when no instances", async () => {
    expect(await activeInstanceCount(getApp())).toBe(0);
  });
});
