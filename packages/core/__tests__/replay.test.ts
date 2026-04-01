import { describe, it, expect } from "bun:test";
import { buildReplay } from "../replay.js";
import { createSession, logEvent } from "../store.js";
import { withTestContext } from "./test-helpers.js";

withTestContext();

describe("buildReplay", () => {
  it("returns empty array for session with no events beyond creation", () => {
    // createSession logs a session_created event, so we test a non-existent session
    const steps = buildReplay("s-nonexistent");
    expect(steps).toEqual([]);
  });

  it("returns steps in chronological order", () => {
    const session = createSession({ summary: "test replay", flow: "default" });
    logEvent(session.id, "stage_ready", { stage: "plan", data: { stage: "plan" } });
    logEvent(session.id, "stage_started", { stage: "plan", actor: "planner", data: { stage: "plan", agent: "planner" } });

    const steps = buildReplay(session.id);
    expect(steps.length).toBeGreaterThanOrEqual(3);

    // Verify chronological order
    for (let i = 1; i < steps.length; i++) {
      expect(steps[i].timestamp >= steps[i - 1].timestamp).toBe(true);
    }
  });

  it("steps have correct index values", () => {
    const session = createSession({ summary: "test indexing" });
    logEvent(session.id, "stage_ready", { data: { stage: "plan" } });
    logEvent(session.id, "stage_started", { data: { stage: "plan", agent: "planner" } });

    const steps = buildReplay(session.id);
    steps.forEach((step, i) => {
      expect(step.index).toBe(i);
    });
  });

  it("steps have elapsed time formatted as HH:MM:SS", () => {
    const session = createSession({ summary: "elapsed test" });
    const steps = buildReplay(session.id);
    expect(steps.length).toBeGreaterThan(0);
    // First step should be near 00:00:00
    expect(steps[0].elapsed).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  });

  it("session_created event has meaningful summary", () => {
    const session = createSession({ summary: "My important task", flow: "quick" });
    const steps = buildReplay(session.id);
    const created = steps.find((s) => s.type === "session_created");
    expect(created).toBeDefined();
    expect(created!.summary).toContain("quick");
    expect(created!.summary).toContain("My important task");
  });

  it("stage_started event includes agent name", () => {
    const session = createSession({ summary: "agent test" });
    logEvent(session.id, "stage_started", {
      stage: "implement",
      actor: "implementer",
      data: { stage: "implement", agent: "implementer" },
    });

    const steps = buildReplay(session.id);
    const started = steps.find((s) => s.type === "stage_started");
    expect(started).toBeDefined();
    expect(started!.summary).toContain("implement");
    expect(started!.summary).toContain("implementer");
  });

  it("agent_error event shows error preview", () => {
    const session = createSession({ summary: "error test" });
    logEvent(session.id, "agent_error", {
      data: { error: "TypeError: Cannot read properties of null" },
    });

    const steps = buildReplay(session.id);
    const errorStep = steps.find((s) => s.type === "agent_error");
    expect(errorStep).toBeDefined();
    expect(errorStep!.summary).toContain("TypeError");
  });

  it("hook_status event formats correctly", () => {
    const session = createSession({ summary: "hook test" });
    logEvent(session.id, "hook_status", {
      data: { status: "busy", hook_event: "tool_use" },
    });

    const steps = buildReplay(session.id);
    const hookStep = steps.find((s) => s.type === "hook_status");
    expect(hookStep).toBeDefined();
    expect(hookStep!.summary).toContain("busy");
    expect(hookStep!.summary).toContain("tool_use");
  });

  it("retry_with_context event shows attempt number", () => {
    const session = createSession({ summary: "retry test" });
    logEvent(session.id, "retry_with_context", {
      data: { attempt: 2, error: "tests failed" },
    });

    const steps = buildReplay(session.id);
    const retryStep = steps.find((s) => s.type === "retry_with_context");
    expect(retryStep).toBeDefined();
    expect(retryStep!.summary).toContain("2");
    expect(retryStep!.summary).toContain("tests failed");
  });

  it("steps include detail when data is present", () => {
    const session = createSession({ summary: "detail test" });
    logEvent(session.id, "agent_completed", {
      data: { summary: "Done", files_changed: 5, commits: 2 },
    });

    const steps = buildReplay(session.id);
    const completed = steps.find((s) => s.type === "agent_completed");
    expect(completed).toBeDefined();
    expect(completed!.detail).toBeTruthy();
    expect(completed!.detail).toContain("summary");
  });

  it("preserves stage and actor from events", () => {
    const session = createSession({ summary: "stage test" });
    logEvent(session.id, "stage_started", {
      stage: "review",
      actor: "reviewer",
      data: { stage: "review", agent: "reviewer" },
    });

    const steps = buildReplay(session.id);
    const started = steps.find((s) => s.type === "stage_started");
    expect(started).toBeDefined();
    expect(started!.stage).toBe("review");
    expect(started!.actor).toBe("reviewer");
  });
});
