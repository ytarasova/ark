/**
 * Tests for the event formatter.
 *
 * formatEvent converts raw event types and data into human-readable
 * strings displayed in the TUI session detail pane.
 */

import { describe, it, expect } from "bun:test";
import { formatEvent } from "../helpers/formatEvent.js";

describe("formatEvent", () => {
  it("formats session_created with summary", () => {
    const msg = formatEvent("session_created", { summary: "Add auth" });
    expect(msg).toContain("Add auth");
    expect(msg).toContain("Session created");
  });

  it("formats session_created with jira_summary fallback", () => {
    const msg = formatEvent("session_created", { jira_summary: "Fix login bug" });
    expect(msg).toContain("Fix login bug");
  });

  it("formats session_created with default text when no summary", () => {
    const msg = formatEvent("session_created", {});
    expect(msg).toContain("new task");
  });

  it("formats stage_ready", () => {
    const msg = formatEvent("stage_ready", { stage: "review" });
    expect(msg).toContain("review");
    expect(msg).toContain("Ready");
  });

  it("formats stage_started with agent", () => {
    const msg = formatEvent("stage_started", { agent: "implementer", stage: "work" });
    expect(msg).toContain("implementer");
    expect(msg).toContain("Agent started");
  });

  it("formats stage_completed", () => {
    const msg = formatEvent("stage_completed", { stage: "work" });
    expect(msg).toContain("Stage completed");
  });

  it("formats agent_exited with last_output", () => {
    const msg = formatEvent("agent_exited", { last_output: "Error: connection refused" });
    expect(msg).toContain("crashed");
    expect(msg).toContain("connection refused");
  });

  it("formats agent_exited without output shows no output", () => {
    const msg = formatEvent("agent_exited", {});
    expect(msg).toContain("no output");
  });

  it("formats agent_exited with empty string output shows no output", () => {
    const msg = formatEvent("agent_exited", { last_output: "" });
    expect(msg).toContain("no output");
  });

  it("formats session_stopped", () => {
    const msg = formatEvent("session_stopped");
    expect(msg.toLowerCase()).toContain("stopped");
  });

  it("formats session_resumed with from_status", () => {
    const msg = formatEvent("session_resumed", { from_status: "failed" });
    expect(msg).toContain("failed");
    expect(msg.toLowerCase()).toContain("retried");
  });

  it("formats session_completed", () => {
    const msg = formatEvent("session_completed");
    expect(msg.toLowerCase()).toContain("completed");
  });

  it("formats session_cloned", () => {
    const msg = formatEvent("session_cloned", { cloned_from: "s-abc123" });
    expect(msg).toContain("s-abc123");
    expect(msg.toLowerCase()).toContain("cloned");
  });

  it("formats session_paused", () => {
    const msg = formatEvent("session_paused", { reason: "waiting for review" });
    expect(msg).toContain("waiting for review");
    expect(msg.toLowerCase()).toContain("paused");
  });

  it("formats fork_started", () => {
    const msg = formatEvent("fork_started", { children_count: 3 });
    expect(msg).toContain("3");
    expect(msg.toLowerCase()).toContain("fork");
  });

  it("formats fork_joined", () => {
    const msg = formatEvent("fork_joined");
    expect(msg.toLowerCase()).toContain("joined");
  });

  it("formats session_handoff", () => {
    const msg = formatEvent("session_handoff", { to_agent: "reviewer" });
    expect(msg).toContain("reviewer");
    expect(msg.toLowerCase()).toContain("handed off");
  });

  it("humanizes unknown event types", () => {
    expect(formatEvent("some_custom_event")).toBe("Some custom event");
  });

  it("humanizes single-word unknown event type", () => {
    expect(formatEvent("initialized")).toBe("Initialized");
  });

  it("handles undefined data gracefully", () => {
    // All known event types should handle missing data without throwing
    const types = [
      "session_created", "stage_ready", "stage_started", "stage_completed",
      "agent_exited", "session_stopped", "session_resumed", "session_completed",
      "session_cloned", "session_paused", "fork_started", "fork_joined",
      "session_handoff",
    ];
    for (const type of types) {
      expect(() => formatEvent(type)).not.toThrow();
      expect(() => formatEvent(type, undefined)).not.toThrow();
    }
  });
});
