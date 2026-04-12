import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { SessionReplay } from "../tabs/SessionReplay.js";
import { ArkClientProvider } from "../context/ArkClientProvider.js";
import type { Session } from "../../core/index.js";
import { AppContext, setApp, clearApp } from "../../core/app.js";
import { startSession } from "../../core/services/session-orchestration.js";
import { waitFor } from "../../core/__tests__/test-helpers.js";

let app: AppContext;
beforeAll(async () => {
  app = AppContext.forTest();
  setApp(app);
  await app.boot();
});
afterAll(async () => {
  await app?.shutdown();
  clearApp();
});

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

/** Render with ArkClientProvider and wait for RPC client to be ready. */
async function renderReplay(session: Session) {
  let ready = false;
  const result = render(
    <ArkClientProvider app={app} onReady={() => { ready = true; }}>
      <SessionReplay session={session} onClose={() => {}} />
    </ArkClientProvider>,
  );
  await waitFor(() => ready);
  return result;
}

describe("SessionReplay", () => {
  it("renders session header with id and flow", async () => {
    const session = makeSession();
    const { lastFrame, unmount } = await renderReplay(session);
    // Wait for async render
    await waitFor(() => (lastFrame() ?? "").includes("s-abc123"));
    const frame = lastFrame()!;
    expect(frame).toContain("s-abc123");
    expect(frame).toContain("default");
    expect(frame).toContain("completed");
    unmount();
  });

  it("renders the separator line", async () => {
    const session = makeSession();
    const { lastFrame, unmount } = await renderReplay(session);
    await waitFor(() => (lastFrame() ?? "").includes("━"));
    const frame = lastFrame()!;
    expect(frame).toContain("━");
    unmount();
  });

  it("shows event count in header for session with events", async () => {
    // Create a real session with events so replay returns data
    const s = startSession(app, { summary: "replay-test", repo: ".", flow: "bare" });
    app.events.log(s.id, "session_created", { data: { summary: "replay-test" } });
    app.events.log(s.id, "stage_started", { data: { stage: "plan", agent: "planner" } });

    const session = makeSession({ id: s.id, summary: "replay-test", flow: "bare" });
    const { lastFrame, unmount } = await renderReplay(session);
    // Wait for the RPC call to complete and steps to render
    await waitFor(() => (lastFrame() ?? "").includes("events"));
    const frame = lastFrame()!;
    expect(frame).toContain("events");
    unmount();
  });
});
