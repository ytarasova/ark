import { describe, it, expect } from "bun:test";
import { withTestContext } from "./test-helpers.js";
import { getApp } from "../app.js";
import * as session from "../services/session-orchestration.js";

const { getCtx } = withTestContext();

describe("sub-agent fan-out", () => {
  it("creates correct number of children", () => {
    const parent = getApp().sessions.create({ summary: "build feature", flow: "bare" });

    const result = session.fanOut(parent.id, {
      tasks: [
        { summary: "Implement auth module", agent: "implementer" },
        { summary: "Write auth tests", agent: "implementer" },
        { summary: "Update docs", agent: "documenter" },
      ],
    });

    expect(result.ok).toBe(true);
    expect(result.childIds).toHaveLength(3);
  });

  it("children linked to parent", () => {
    const parent = getApp().sessions.create({ summary: "build feature", flow: "bare" });

    const result = session.fanOut(parent.id, {
      tasks: [
        { summary: "task A" },
        { summary: "task B" },
      ],
    });

    for (const childId of result.childIds!) {
      const child = getApp().sessions.get(childId)!;
      expect(child.parent_id).toBe(parent.id);
      expect(child.status).toBe("ready");
    }
  });

  it("children share fork_group", () => {
    const parent = getApp().sessions.create({ summary: "test", flow: "bare" });
    const result = session.fanOut(parent.id, {
      tasks: [
        { summary: "task 1" },
        { summary: "task 2" },
      ],
    });

    const child1 = getApp().sessions.get(result.childIds![0])!;
    const child2 = getApp().sessions.get(result.childIds![1])!;
    expect(child1.fork_group).toBeDefined();
    expect(child1.fork_group).toBe(child2.fork_group);
  });

  it("parent in waiting state", () => {
    const parent = getApp().sessions.create({ summary: "test", flow: "bare" });
    session.fanOut(parent.id, {
      tasks: [{ summary: "task 1" }],
    });

    const updated = getApp().sessions.get(parent.id)!;
    expect(updated.status).toBe("waiting");
  });

  it("empty task list rejected", () => {
    const parent = getApp().sessions.create({ summary: "test", flow: "bare" });
    const result = session.fanOut(parent.id, { tasks: [] });

    expect(result.ok).toBe(false);
    expect(result.message).toContain("No tasks provided");
  });
});
