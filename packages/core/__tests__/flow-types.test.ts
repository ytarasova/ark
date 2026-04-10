/**
 * Tests for fan_out stage type recognition in getStageAction().
 */

import { describe, test, expect } from "bun:test";
import { getStageAction } from "../state/flow.js";
import { withTestContext } from "./test-helpers.js";

withTestContext();

describe("fan_out stage type", () => {
  test("fan-out flow execute stage has type fan_out (not unknown)", () => {
    const action = getStageAction("fan-out", "execute");
    expect(action.type).toBe("fan_out");
  });

  test("fan-out flow execute stage has default agent implementer", () => {
    const action = getStageAction("fan-out", "execute");
    expect(action.agent).toBe("implementer");
  });

  test("fan-out flow execute stage has default strategy plan", () => {
    const action = getStageAction("fan-out", "execute");
    expect(action.strategy).toBe("plan");
  });

  test("fan-out flow execute stage has default max_parallel 4", () => {
    const action = getStageAction("fan-out", "execute");
    expect(action.max_parallel).toBe(4);
  });

  test("parallel flow implement stage has type fork", () => {
    const action = getStageAction("parallel", "implement");
    expect(action.type).toBe("fork");
  });

  test("parallel flow implement stage has agent implementer", () => {
    const action = getStageAction("parallel", "implement");
    expect(action.agent).toBe("implementer");
  });

  test("parallel flow implement stage has strategy plan", () => {
    const action = getStageAction("parallel", "implement");
    expect(action.strategy).toBe("plan");
  });

  test("parallel flow implement stage has max_parallel 4", () => {
    const action = getStageAction("parallel", "implement");
    expect(action.max_parallel).toBe(4);
  });
});
