import { describe, it, expect } from "bun:test";
import { withTestContext } from "./test-helpers.js";
import * as store from "../store.js";
import * as session from "../session.js";

const { getCtx } = withTestContext();

describe("sub-agent fan-out", () => {
  it("creates correct number of children", () => {
    const parent = store.createSession({ summary: "build feature", flow: "bare" });

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
    const parent = store.createSession({ summary: "build feature", flow: "bare" });

    const result = session.fanOut(parent.id, {
      tasks: [
        { summary: "task A" },
        { summary: "task B" },
      ],
    });

    for (const childId of result.childIds!) {
      const child = store.getSession(childId)!;
      expect(child.parent_id).toBe(parent.id);
      expect(child.status).toBe("ready");
    }
  });

  it("children share fork_group", () => {
    const parent = store.createSession({ summary: "test", flow: "bare" });
    const result = session.fanOut(parent.id, {
      tasks: [
        { summary: "task 1" },
        { summary: "task 2" },
      ],
    });

    const child1 = store.getSession(result.childIds![0])!;
    const child2 = store.getSession(result.childIds![1])!;
    expect(child1.fork_group).toBeDefined();
    expect(child1.fork_group).toBe(child2.fork_group);
  });

  it("parent in waiting state", () => {
    const parent = store.createSession({ summary: "test", flow: "bare" });
    session.fanOut(parent.id, {
      tasks: [{ summary: "task 1" }],
    });

    const updated = store.getSession(parent.id)!;
    expect(updated.status).toBe("waiting");
  });

  it("empty task list rejected", () => {
    const parent = store.createSession({ summary: "test", flow: "bare" });
    const result = session.fanOut(parent.id, { tasks: [] });

    expect(result.ok).toBe(false);
    expect(result.message).toContain("No tasks provided");
  });
});
