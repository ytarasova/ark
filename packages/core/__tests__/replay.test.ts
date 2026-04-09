import { describe, it, expect } from "bun:test";
import { buildReplay } from "../replay.js";
import { getApp } from "../app.js";
import { startSession } from "../services/session-orchestration.js";
import { withTestContext } from "./test-helpers.js";

withTestContext();

describe("buildReplay", () => {
  it("returns empty array for session with no events beyond creation", () => {
    // createSession logs a session_created event, so we test a non-existent session
    const steps = buildReplay(getApp(), "s-nonexistent");
    expect(steps).toEqual([]);
  });

  it("returns steps in chronological order", () => {
    const session = startSession(getApp(), { summary: "test replay", flow: "default" });
    getApp().events.log(session.id, "stage_ready", { stage: "plan", data: { stage: "plan" } });
    getApp().events.log(session.id, "stage_started", { stage: "plan", actor: "planner", data: { stage: "plan", agent: "planner" } });

    const steps = buildReplay(getApp(), session.id);
    expect(steps.length).toBeGreaterThanOrEqual(3);

    // Verify chronological order
    for (let i = 1; i < steps.length; i++) {
      expect(steps[i].timestamp >= steps[i - 1].timestamp).toBe(true);
    }
  });

  it("steps have correct index values", () => {
    const session = getApp().sessions.create({ summary: "test indexing" });
    getApp().events.log(session.id, "stage_ready", { data: { stage: "plan" } });
    getApp().events.log(session.id, "stage_started", { data: { stage: "plan", agent: "planner" } });

    const steps = buildReplay(getApp(), session.id);
    steps.forEach((step, i) => {
      expect(step.index).toBe(i);
    });
  });

  it("steps have elapsed time formatted as HH:MM:SS", () => {
    const session = startSession(getApp(), { summary: "elapsed test" });
    const steps = buildReplay(getApp(), session.id);
    expect(steps.length).toBeGreaterThan(0);
    // First step should be near 00:00:00
    expect(steps[0].elapsed).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  });

  it("session_created event has meaningful summary", () => {
    const session = getApp().sessions.create({ summary: "My important task", flow: "quick" });
    getApp().events.log(session.id, "session_created", {
      data: { flow: "quick", summary: "My important task" },
    });
    const steps = buildReplay(getApp(), session.id);
    const created = steps.find((s) => s.type === "session_created");
    expect(created).toBeDefined();
    expect(created!.summary).toContain("quick");
    expect(created!.summary).toContain("My important task");
  });

  it("stage_started event includes agent name", () => {
    const session = getApp().sessions.create({ summary: "agent test" });
    getApp().events.log(session.id, "stage_started", {
      stage: "implement",
      actor: "implementer",
      data: { stage: "implement", agent: "implementer" },
    });

    const steps = buildReplay(getApp(), session.id);
    const started = steps.find((s) => s.type === "stage_started");
    expect(started).toBeDefined();
    expect(started!.summary).toContain("implement");
    expect(started!.summary).toContain("implementer");
  });

  it("agent_error event shows error preview", () => {
    const session = getApp().sessions.create({ summary: "error test" });
    getApp().events.log(session.id, "agent_error", {
      data: { error: "TypeError: Cannot read properties of null" },
    });

    const steps = buildReplay(getApp(), session.id);
    const errorStep = steps.find((s) => s.type === "agent_error");
    expect(errorStep).toBeDefined();
    expect(errorStep!.summary).toContain("TypeError");
  });

  it("hook_status event formats correctly", () => {
    const session = getApp().sessions.create({ summary: "hook test" });
    getApp().events.log(session.id, "hook_status", {
      data: { status: "busy", hook_event: "tool_use" },
    });

    const steps = buildReplay(getApp(), session.id);
    const hookStep = steps.find((s) => s.type === "hook_status");
    expect(hookStep).toBeDefined();
    expect(hookStep!.summary).toContain("busy");
    expect(hookStep!.summary).toContain("tool_use");
  });

  it("retry_with_context event shows attempt number", () => {
    const session = getApp().sessions.create({ summary: "retry test" });
    getApp().events.log(session.id, "retry_with_context", {
      data: { attempt: 2, error: "tests failed" },
    });

    const steps = buildReplay(getApp(), session.id);
    const retryStep = steps.find((s) => s.type === "retry_with_context");
    expect(retryStep).toBeDefined();
    expect(retryStep!.summary).toContain("2");
    expect(retryStep!.summary).toContain("tests failed");
  });

  it("steps include detail when data is present", () => {
    const session = getApp().sessions.create({ summary: "detail test" });
    getApp().events.log(session.id, "agent_completed", {
      data: { summary: "Done", files_changed: 5, commits: 2 },
    });

    const steps = buildReplay(getApp(), session.id);
    const completed = steps.find((s) => s.type === "agent_completed");
    expect(completed).toBeDefined();
    expect(completed!.detail).toBeTruthy();
    expect(completed!.detail).toContain("summary");
  });

  it("preserves stage and actor from events", () => {
    const session = getApp().sessions.create({ summary: "stage test" });
    getApp().events.log(session.id, "stage_started", {
      stage: "review",
      actor: "reviewer",
      data: { stage: "review", agent: "reviewer" },
    });

    const steps = buildReplay(getApp(), session.id);
    const started = steps.find((s) => s.type === "stage_started");
    expect(started).toBeDefined();
    expect(started!.stage).toBe("review");
    expect(started!.actor).toBe("reviewer");
  });
});
