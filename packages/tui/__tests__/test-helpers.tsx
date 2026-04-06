/**
 * Test helpers for TUI component tests.
 * Provides isolated store context, render wrappers, and mock ArkClient.
 */

import React from "react";
import { render } from "ink-testing-library";
import { StoreProvider, createMockStore } from "../context/StoreProvider.js";
import { ArkClientContext } from "../hooks/useArkClient.js";
import type { ArkClient } from "../../protocol/client.js";
import type { StoreData } from "../hooks/useArkStore.js";
import type { Session, Compute } from "../../core/index.js";

/**
 * Create a mock ArkClient with stub methods that resolve to empty data.
 * Override individual methods as needed.
 */
export function createMockArkClient(overrides?: Partial<ArkClient>): ArkClient {
  const noop = async () => ({});
  const noopList = async () => [];
  const noopVoid = async () => {};
  const noopString = async () => "";

  return {
    initialize: noop,
    on: () => {},
    off: () => {},
    close: () => {},
    sessionStart: noop,
    sessionDispatch: noop,
    sessionStop: noopVoid,
    sessionAdvance: noop,
    sessionComplete: noopVoid,
    sessionDelete: noopVoid,
    sessionUndelete: noop,
    sessionFork: noop,
    sessionClone: noop,
    sessionUpdate: noop,
    sessionList: noopList,
    sessionRead: noop,
    sessionEvents: noopList,
    sessionMessages: noopList,
    sessionSearch: noopList,
    sessionConversation: noopList,
    sessionSearchConversation: noopList,
    sessionOutput: noopString,
    sessionHandoff: noop,
    sessionJoin: noop,
    sessionSpawn: noop,
    sessionResume: noop,
    sessionPause: noop,
    worktreeFinish: noop,
    messageSend: noopVoid,
    messageMarkRead: noopVoid,
    gateApprove: noop,
    agentList: noopList,
    flowList: noopList,
    flowRead: noop,
    skillList: noopList,
    skillRead: noop,
    recipeList: noopList,
    recipeRead: noop,
    recipeUse: noop,
    computeList: noopList,
    computeCreate: noop,
    computeDelete: noopVoid,
    computeUpdate: noopVoid,
    computeRead: noop,
    computeProvision: noopVoid,
    computeStopInstance: noopVoid,
    computeStartInstance: noopVoid,
    computeDestroy: noopVoid,
    computeClean: noopVoid,
    computeReboot: noopVoid,
    computePing: async () => ({ reachable: false, message: "" }),
    computeCleanZombies: async () => ({ cleaned: 0 }),
    groupList: noopList,
    groupCreate: noop,
    groupDelete: noopVoid,
    configRead: noop,
    configWrite: noop,
    profileList: async () => ({ profiles: [], active: null }),
    profileSet: noopVoid,
    profileCreate: noop,
    profileDelete: noopVoid,
    historyList: noopList,
    historyImport: noop,
    historyRefresh: async () => ({ ok: true, count: 0 }),
    historyIndex: async () => ({ ok: true, count: 0 }),
    historyRebuildFts: async () => ({ ok: true, sessionCount: 0, indexCount: 0, items: [] }),
    historyRefreshAndIndex: async () => ({ ok: true, sessionCount: 0, indexCount: 0, items: [] }),
    historySearch: noopList,
    toolsList: noopList,
    toolsDelete: noopVoid,
    toolsDeleteItem: noopVoid,
    toolsRead: noop,
    mcpAttach: noopVoid,
    mcpDetach: noopVoid,
    metricsSnapshot: noop,
    costsRead: async () => ({ costs: [], total: 0 }),
    memoryList: noopList,
    memoryRecall: noopList,
    memoryForget: async () => true,
    scheduleList: noopList,
    scheduleCreate: noop,
    scheduleDelete: async () => true,
    scheduleEnable: noopVoid,
    scheduleDisable: noopVoid,
    indexStats: noop,
    ...overrides,
  } as ArkClient;
}

/** Wrap children in a mock ArkClient context. */
export function MockArkClientProvider({ client, children }: {
  client: ArkClient;
  children: React.ReactNode;
}) {
  return (
    <ArkClientContext.Provider value={client}>
      {children}
    </ArkClientContext.Provider>
  );
}

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
