/**
 * Tests for StageProgressBar logic.
 *
 * The component renders colored segments based on stage state.
 * We test the data logic (which CSS class maps to which state)
 * and the buildStageProgress() helper from SessionDetail/SessionList.
 */

import { describe, test, expect } from "bun:test";

// ---------------------------------------------------------------------------
// Types (from StageProgressBar.tsx)
// ---------------------------------------------------------------------------

interface StageProgress {
  name: string;
  state: "done" | "active" | "pending" | "failed";
}

// ---------------------------------------------------------------------------
// Extracted buildStageProgress from SessionDetail.tsx
// ---------------------------------------------------------------------------

function buildStageProgress(session: any, flowStages: any[]): StageProgress[] {
  if (!flowStages || flowStages.length === 0) return [];
  const currentStage = session.stage;
  const currentIdx = flowStages.findIndex((s: any) => s.name === currentStage);
  const isFailed = session.status === "failed";
  const isCompleted = session.status === "completed";
  const isRunning = session.status === "running" || session.status === "waiting";

  return flowStages.map((s: any, i: number) => {
    if (isCompleted) return { name: s.name, state: "done" as const };
    if (isFailed && i === currentIdx) return { name: s.name, state: "failed" as const };
    if (currentIdx < 0) return { name: s.name, state: "pending" as const };
    if (i < currentIdx) return { name: s.name, state: "done" as const };
    if (i === currentIdx) return { name: s.name, state: isRunning ? ("active" as const) : ("pending" as const) };
    return { name: s.name, state: "pending" as const };
  });
}

// ---------------------------------------------------------------------------
// CSS class mapping (mirrors StageProgressBar.tsx render logic)
// ---------------------------------------------------------------------------

function stateToColor(state: "done" | "active" | "pending" | "failed"): string {
  // --running = #60a5fa (blue), --completed = #34d399 (green)
  switch (state) {
    case "done":
      return "bg-[var(--completed)]"; // green
    case "active":
      return "bg-[var(--running)]"; // blue
    case "failed":
      return "bg-[var(--failed)]"; // red
    case "pending":
      return "bg-[var(--border)]"; // gray
  }
}

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

const STAGES = [{ name: "plan" }, { name: "implement" }, { name: "verify" }, { name: "review" }, { name: "pr" }];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("buildStageProgress", () => {
  test("renders correct number of segments", () => {
    const session = { stage: "implement", status: "running" };
    const result = buildStageProgress(session, STAGES);
    expect(result).toHaveLength(5);
  });

  test("completed stages are done, current is active, rest are pending", () => {
    const session = { stage: "verify", status: "running" };
    const result = buildStageProgress(session, STAGES);

    expect(result[0]).toEqual({ name: "plan", state: "done" });
    expect(result[1]).toEqual({ name: "implement", state: "done" });
    expect(result[2]).toEqual({ name: "verify", state: "active" });
    expect(result[3]).toEqual({ name: "review", state: "pending" });
    expect(result[4]).toEqual({ name: "pr", state: "pending" });
  });

  test("all stages are done when session is completed", () => {
    const session = { stage: "pr", status: "completed" };
    const result = buildStageProgress(session, STAGES);

    for (const s of result) {
      expect(s.state).toBe("done");
    }
  });

  test("failed session marks current stage as failed, rest as expected", () => {
    const session = { stage: "verify", status: "failed" };
    const result = buildStageProgress(session, STAGES);

    expect(result[0]).toEqual({ name: "plan", state: "done" });
    expect(result[1]).toEqual({ name: "implement", state: "done" });
    expect(result[2]).toEqual({ name: "verify", state: "failed" });
    expect(result[3]).toEqual({ name: "review", state: "pending" });
    expect(result[4]).toEqual({ name: "pr", state: "pending" });
  });

  test("failed session at last stage shows red, not green", () => {
    const session = { stage: "pr", status: "failed" };
    const result = buildStageProgress(session, STAGES);

    // All prior stages done
    for (let i = 0; i < result.length - 1; i++) {
      expect(result[i].state).toBe("done");
    }
    // Last stage must be failed, not active/done
    expect(result[result.length - 1]).toEqual({ name: "pr", state: "failed" });
  });

  test("handles empty stages array", () => {
    const session = { stage: "plan", status: "running" };
    const result = buildStageProgress(session, []);
    expect(result).toHaveLength(0);
  });

  test("handles null/undefined stages", () => {
    const session = { stage: "plan", status: "running" };
    expect(buildStageProgress(session, null as any)).toHaveLength(0);
    expect(buildStageProgress(session, undefined as any)).toHaveLength(0);
  });

  test("stopped session does not show active shimmer", () => {
    const session = { stage: "verify", status: "stopped" };
    const result = buildStageProgress(session, STAGES);

    expect(result[0]).toEqual({ name: "plan", state: "done" });
    expect(result[1]).toEqual({ name: "implement", state: "done" });
    // Current stage should be pending (no shimmer), not active
    expect(result[2]).toEqual({ name: "verify", state: "pending" });
    expect(result[3]).toEqual({ name: "review", state: "pending" });
    expect(result[4]).toEqual({ name: "pr", state: "pending" });
  });

  test("all stages pending when current stage is not found", () => {
    const session = { stage: "nonexistent", status: "running" };
    const result = buildStageProgress(session, STAGES);

    for (const s of result) {
      expect(s.state).toBe("pending");
    }
  });

  test("first stage active marks only first as active", () => {
    const session = { stage: "plan", status: "running" };
    const result = buildStageProgress(session, STAGES);

    expect(result[0]).toEqual({ name: "plan", state: "active" });
    for (let i = 1; i < result.length; i++) {
      expect(result[i].state).toBe("pending");
    }
  });

  test("last stage active marks all prior as done", () => {
    const session = { stage: "pr", status: "running" };
    const result = buildStageProgress(session, STAGES);

    for (let i = 0; i < result.length - 1; i++) {
      expect(result[i].state).toBe("done");
    }
    expect(result[result.length - 1].state).toBe("active");
  });
});

describe("stateToColor mapping", () => {
  test("done maps to green (--completed)", () => {
    expect(stateToColor("done")).toBe("bg-[var(--completed)]");
  });

  test("active maps to blue (--running)", () => {
    expect(stateToColor("active")).toBe("bg-[var(--running)]");
  });

  test("failed maps to failed color (red)", () => {
    expect(stateToColor("failed")).toBe("bg-[var(--failed)]");
  });

  test("pending maps to border color (dim)", () => {
    expect(stateToColor("pending")).toBe("bg-[var(--border)]");
  });
});
