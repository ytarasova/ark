/**
 * Test helpers for TUI component tests.
 * Provides isolated store context and render wrappers.
 */

import React from "react";
import { render } from "ink-testing-library";
import { StoreProvider, createMockStore } from "../context/StoreProvider.js";
import type { StoreData } from "../hooks/useArkStore.js";
import type { Session, Compute } from "../../core/index.js";

/** Render a component wrapped in StoreProvider with mock data. */
export function renderWithStore(
  ui: React.ReactElement,
  storeOverrides?: Partial<StoreData>,
): ReturnType<typeof render> {
  const store = createMockStore(storeOverrides);
  return render(
    <StoreProvider store={store}>
      {ui}
    </StoreProvider>
  );
}

/** Create a fake session for tests. */
export function fakeSession(overrides?: Partial<Session>): Session {
  return {
    id: "s-test01",
    ticket: null,
    summary: "Test session",
    repo: "/tmp/test-repo",
    branch: null,
    compute_name: "local",
    session_id: null,
    claude_session_id: null,
    stage: "work",
    status: "ready",
    flow: "bare",
    agent: null,
    workdir: "/tmp/test-repo",
    pr_url: null,
    pr_id: null,
    error: null,
    parent_id: null,
    fork_group: null,
    group_name: null,
    breakpoint_reason: null,
    attached_by: null,
    config: {},
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

/** Create a fake compute for tests. */
export function fakeCompute(overrides?: Partial<Compute>): Compute {
  return {
    name: "test-compute",
    provider: "local",
    status: "running",
    config: {},
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}
