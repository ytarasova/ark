/**
 * Tests for useStore hook — central store with fingerprint-based re-renders.
 * Uses refresh() (sync path) instead of waiting for async poll cycle.
 */

import { describe, it, expect } from "bun:test";
import React, { useEffect } from "react";
import { render } from "ink-testing-library";
import { Text } from "ink";
import {
  addMessage,
} from "../../core/index.js";
import { createSession } from "../../core/store.js";
import { useStore } from "../hooks/useStore.js";
import type { StoreData } from "../hooks/useStore.js";
import { withTestContext, waitFor } from "../../core/__tests__/test-helpers.js";

withTestContext();

// Captures store data and immediately triggers a sync refresh
let captured: StoreData | null = null;

function StoreCapture() {
  const store = useStore(60000); // long poll — we use refresh() manually
  captured = store;

  // Trigger a sync refresh on mount so data is available immediately
  useEffect(() => { store.refresh(); }, []);

  return <Text>{`s=${store.sessions.length} c=${store.computes.length}`}</Text>;
}

describe("useStore", () => {
  it("provides all required StoreData fields", async () => {
    captured = null;
    const { unmount } = render(<StoreCapture />);
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
    expect(typeof captured!.refreshing).toBe("boolean");
    unmount();
  });

  it("includes sessions from the database", async () => {
    createSession({ summary: "test-session" });
    captured = null;
    const { unmount } = render(<StoreCapture />);
    await waitFor(() => captured !== null && captured.sessions.length === 1);

    expect(captured!.sessions.length).toBe(1);
    expect(captured!.sessions[0].summary).toBe("test-session");
    unmount();
  });

  it("includes local compute by default", async () => {
    captured = null;
    const { unmount } = render(<StoreCapture />);
    await waitFor(() => captured !== null && captured.computes.length >= 1);

    expect(captured!.computes.length).toBeGreaterThanOrEqual(1);
    expect(captured!.computes.some(c => c.name === "local")).toBe(true);
    unmount();
  });

  it("computes unreadCounts from messages table", async () => {
    const session = createSession({ summary: "msg-test" });
    addMessage({ session_id: session.id, role: "agent", content: "hello" });
    addMessage({ session_id: session.id, role: "agent", content: "world" });

    captured = null;
    const { unmount } = render(<StoreCapture />);
    await waitFor(() => captured !== null && captured.unreadCounts.get(session.id) === 2);

    expect(captured!.unreadCounts.get(session.id)).toBe(2);
    unmount();
  });

  it("unreadCounts excludes user messages", async () => {
    const session = createSession({ summary: "user-msg" });
    addMessage({ session_id: session.id, role: "user", content: "hi" });

    captured = null;
    const { unmount } = render(<StoreCapture />);
    await waitFor(() => captured !== null);

    expect(captured!.unreadCounts.has(session.id)).toBe(false);
    unmount();
  });

  it("refresh() picks up new data immediately", async () => {
    captured = null;
    const { unmount } = render(<StoreCapture />);
    await waitFor(() => captured !== null);
    expect(captured!.sessions.length).toBe(0);

    createSession({ summary: "after-refresh" });
    captured!.refresh();
    await waitFor(() => captured !== null && captured.sessions.length === 1);

    expect(captured!.sessions.length).toBe(1);
    unmount();
  });

  it("addComputeLog appends to computeLogs", async () => {
    captured = null;
    const { unmount } = render(<StoreCapture />);
    await waitFor(() => captured !== null);

    captured!.addComputeLog("local", "test log entry");
    await waitFor(() => (captured!.computeLogs.get("local")?.length ?? 0) >= 1);

    const logs = captured!.computeLogs.get("local");
    expect(logs).toBeDefined();
    expect(logs!.length).toBe(1);
    expect(logs![0]).toContain("test log entry");
    unmount();
  });

  it("snapshots map is a Map", async () => {
    captured = null;
    const { unmount } = render(<StoreCapture />);
    await waitFor(() => captured !== null);

    expect(captured!.snapshots).toBeInstanceOf(Map);
    unmount();
  });
});
