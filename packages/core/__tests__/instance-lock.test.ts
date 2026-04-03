import { describe, it, expect, afterEach } from "bun:test";
import { registerInstance, activeInstanceCount } from "../instance-lock.js";
import { withTestContext } from "./test-helpers.js";

withTestContext();

describe("multi-instance coordination", () => {
  let cleanups: (() => void)[] = [];
  afterEach(() => { cleanups.forEach(fn => fn()); cleanups = []; });

  it("registerInstance creates a heartbeat entry", () => {
    const inst = registerInstance("test-1");
    cleanups.push(inst.stop);
    expect(activeInstanceCount()).toBe(1);
  });

  it("first registered instance is primary", () => {
    const inst1 = registerInstance("inst-a");
    cleanups.push(inst1.stop);
    const inst2 = registerInstance("inst-b");
    cleanups.push(inst2.stop);
    expect(inst1.isPrimary()).toBe(true);
    expect(inst2.isPrimary()).toBe(false);
  });

  it("stop removes the instance", () => {
    const inst = registerInstance("inst-stop");
    inst.stop();
    expect(activeInstanceCount()).toBe(0);
  });

  it("multiple instances are counted", () => {
    const a = registerInstance("a");
    const b = registerInstance("b");
    const c = registerInstance("c");
    cleanups.push(a.stop, b.stop, c.stop);
    expect(activeInstanceCount()).toBe(3);
  });

  it("activeInstanceCount returns 0 when no instances", () => {
    expect(activeInstanceCount()).toBe(0);
  });
});
