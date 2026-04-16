import { describe, it, expect, beforeEach } from "bun:test";
import { withTestContext } from "./test-helpers.js";
import * as core from "../index.js";

withTestContext();

describe("executor integration", () => {
  beforeEach(() => {
    core.registerExecutor(core.subprocessExecutor);
  });

  it("subprocess agent can be defined with runtime + command fields", () => {
    const agent: Partial<core.AgentDefinition> = {
      name: "test-sub",
      runtime: "subprocess",
      command: ["echo", "integrated"],
    };
    expect(agent.runtime).toBe("subprocess");
    expect(agent.command).toEqual(["echo", "integrated"]);
  });

  it("getExecutor resolves registered executors", () => {
    expect(core.getExecutor("subprocess")).toBeDefined();
    expect(core.getExecutor("subprocess")!.name).toBe("subprocess");
  });

  it("listExecutors includes subprocess", () => {
    const names = core.listExecutors().map((e) => e.name);
    expect(names).toContain("subprocess");
  });

  it("executor types are exported from core", () => {
    // Verify the type exports work at runtime
    const stub: core.Executor = {
      name: "test",
      launch: async () => ({ ok: true, handle: "h" }),
      kill: async () => {},
      status: async () => ({ state: "not_found" as const }),
      send: async () => {},
      capture: async () => "",
    };
    core.registerExecutor(stub);
    expect(core.getExecutor("test")).toBe(stub);
  });
});
