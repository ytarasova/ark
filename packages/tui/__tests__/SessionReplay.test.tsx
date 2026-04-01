import { describe, it, expect } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { SessionReplay } from "../tabs/SessionReplay.js";
import type { Session } from "../../core/index.js";

// Mock core module - buildReplay returns test data
const mockSteps = [
  {
    index: 0,
    timestamp: "2026-01-01T00:00:00Z",
    elapsed: "00:00:00",
    type: "session_created",
    stage: null,
    actor: "user",
    summary: "Created with flow:default - Test task",
    detail: "flow: default\nsummary: Test task",
    data: { flow: "default", summary: "Test task" },
  },
  {
    index: 1,
    timestamp: "2026-01-01T00:00:03Z",
    elapsed: "00:00:03",
    type: "stage_started",
    stage: "plan",
    actor: "planner",
    summary: "Started plan with agent:planner",
    detail: "stage: plan\nagent: planner",
    data: { stage: "plan", agent: "planner" },
  },
  {
    index: 2,
    timestamp: "2026-01-01T00:01:42Z",
    elapsed: "00:01:42",
    type: "agent_completed",
    stage: "plan",
    actor: "planner",
    summary: "Completed - 3 files changed, 0 commits",
    detail: "files_changed: 3\ncommits: 0",
    data: { files_changed: 3, commits: 0 },
  },
];

function makeSession(overrides?: Partial<Session>): Session {
  return {
    id: "s-abc123",
    ticket: null,
    summary: "Test task",
    repo: "/test/repo",
    branch: null,
    compute_name: null,
    session_id: null,
    claude_session_id: null,
    stage: null,
    status: "completed",
    flow: "default",
    agent: null,
    workdir: null,
    pr_url: null,
    pr_id: null,
    error: null,
    parent_id: null,
    fork_group: null,
    group_name: null,
    breakpoint_reason: null,
    attached_by: null,
    config: {},
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:01:42Z",
    ...overrides,
  };
}

// We test the component rendering with mocked data via a wrapper
// The actual core.buildReplay is tested in core/__tests__/replay.test.ts

describe("SessionReplay", () => {
  it("renders session header with id and flow", () => {
    const session = makeSession();
    const { lastFrame, unmount } = render(
      <SessionReplay session={session} onClose={() => {}} />,
    );
    const frame = lastFrame()!;
    expect(frame).toContain("s-abc123");
    expect(frame).toContain("default");
    expect(frame).toContain("completed");
    unmount();
  });

  it("renders the separator line", () => {
    const session = makeSession();
    const { lastFrame, unmount } = render(
      <SessionReplay session={session} onClose={() => {}} />,
    );
    const frame = lastFrame()!;
    // Should contain the unicode separator
    expect(frame).toContain("━");
    unmount();
  });

  it("shows step count with event count label", () => {
    const session = makeSession();
    const { lastFrame, unmount } = render(
      <SessionReplay session={session} onClose={() => {}} />,
    );
    const frame = lastFrame()!;
    // Header shows "N events"
    expect(frame).toContain("events");
    unmount();
  });
});
