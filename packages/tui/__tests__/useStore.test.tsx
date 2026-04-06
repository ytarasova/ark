/**
 * Tests for useArkStore / StoreProvider — central store with push-based updates.
 *
 * The old useStore hook (direct DB polling) was replaced by useArkStore
 * (JSON-RPC via ArkClient). These tests validate the StoreData interface
 * and createMockStore helper used by all TUI component tests.
 */

import { describe, it, expect } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { Text } from "ink";
import { StoreProvider, createMockStore, useStoreContext } from "../context/StoreProvider.js";
import type { StoreData } from "../hooks/useArkStore.js";
import { waitFor } from "../../core/__tests__/test-helpers.js";

let captured: StoreData | null = null;

function StoreCapture() {
  const store = useStoreContext();
  captured = store;
  return <Text>{`s=${store.sessions.length} c=${store.computes.length}`}</Text>;
}

function renderWithMock(overrides?: Partial<StoreData>) {
  const store = createMockStore(overrides);
  return render(
    <StoreProvider store={store}>
      <StoreCapture />
    </StoreProvider>
  );
}

describe("useArkStore (via StoreProvider)", () => {
  it("provides all required StoreData fields", async () => {
    captured = null;
    const { unmount } = renderWithMock();
    await waitFor(() => captured !== null);

    expect(captured).not.toBeNull();
    expect(captured!.sessions).toBeInstanceOf(Array);
    expect(captured!.computes).toBeInstanceOf(Array);
    expect(captured!.agents).toBeInstanceOf(Array);
    expect(captured!.flows).toBeInstanceOf(Array);
    expect(captured!.unreadCounts).toBeInstanceOf(Map);
    expect(captured!.snapshots).toBeInstanceOf(Map);
    expect(captured!.computeLogs).toBeInstanceOf(Map);
    expect(typeof captured!.refresh).toBe("function");
    expect(typeof captured!.addComputeLog).toBe("function");
    unmount();
  });

  it("includes sessions from mock data", async () => {
    captured = null;
    const { unmount } = renderWithMock({
      sessions: [{ id: "s-mock01", summary: "test-session", status: "ready" }],
    });
    await waitFor(() => captured !== null && captured.sessions.length === 1);

    expect(captured!.sessions.length).toBe(1);
    expect(captured!.sessions[0].summary).toBe("test-session");
    unmount();
  });

  it("includes computes from mock data", async () => {
    captured = null;
    const { unmount } = renderWithMock({
      computes: [{ name: "local", provider: "local", status: "running" }],
    });
    await waitFor(() => captured !== null && captured.computes.length >= 1);

    expect(captured!.computes.length).toBeGreaterThanOrEqual(1);
    expect(captured!.computes.some((c: any) => c.name === "local")).toBe(true);
    unmount();
  });

  it("provides unreadCounts as a Map", async () => {
    const counts = new Map<string, number>();
    counts.set("s-mock01", 2);

    captured = null;
    const { unmount } = renderWithMock({ unreadCounts: counts });
    await waitFor(() => captured !== null && captured.unreadCounts.get("s-mock01") === 2);

    expect(captured!.unreadCounts.get("s-mock01")).toBe(2);
    unmount();
  });

  it("createMockStore returns defaults for all fields", () => {
    const store = createMockStore();
    expect(store.sessions).toEqual([]);
    expect(store.computes).toEqual([]);
    expect(store.agents).toEqual([]);
    expect(store.flows).toEqual([]);
    expect(store.unreadCounts).toBeInstanceOf(Map);
    expect(store.snapshots).toBeInstanceOf(Map);
    expect(store.computeLogs).toBeInstanceOf(Map);
    expect(store.initialLoading).toBe(false);
    expect(typeof store.refresh).toBe("function");
    expect(typeof store.addComputeLog).toBe("function");
  });

  it("createMockStore applies overrides", () => {
    const store = createMockStore({
      sessions: [{ id: "s-1" }],
    });
    expect(store.sessions.length).toBe(1);
    // Defaults preserved for non-overridden fields
    expect(store.computes).toEqual([]);
  });

  it("snapshots is a Map", async () => {
    captured = null;
    const { unmount } = renderWithMock();
    await waitFor(() => captured !== null);

    expect(captured!.snapshots).toBeInstanceOf(Map);
    unmount();
  });
});
