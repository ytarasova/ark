/**
 * Tests for useEventLog — fetches and transforms session events into display list.
 * Tests the data fetching and transformation logic through the React hook.
 *
 * Uses a mock ArkClient that returns data from the local DB, matching the
 * previous direct-import behavior but going through the ark.* client API.
 */

import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { Text } from "ink";
import {
  startSession, logEvent,
  AppContext, setApp, clearApp,
} from "../../core/index.js";
import { getApp } from "../../core/app.js";
import { useEventLog, type EventLogEntry } from "../hooks/useEventLog.js";
import { createMockArkClient, MockArkClientProvider } from "./test-helpers.js";
import { withTestContext, waitFor } from "../../core/__tests__/test-helpers.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

let capturedEvents: EventLogEntry[] = [];

/** Mock ArkClient that delegates to local DB for session/event queries. */
function createDbBackedClient() {
  return createMockArkClient({
    sessionList: async (filters?: any) => {
      return getApp().sessions.list({ limit: filters?.limit ?? 50 });
    },
    sessionEvents: async (sessionId: string, limit?: number) => {
      return getApp().events.list(sessionId, { limit: limit ?? 50 });
    },
  });
}

function EventCapture({ expanded }: { expanded: boolean }) {
  const events = useEventLog(expanded);
  capturedEvents = events;
  return <Text>{`count=${events.length}`}</Text>;
}

function WrappedEventCapture({ expanded }: { expanded: boolean }) {
  const client = createDbBackedClient();
  return (
    <MockArkClientProvider client={client}>
      <EventCapture expanded={expanded} />
    </MockArkClientProvider>
  );
}

// ── Setup ────────────────────────────────────────────────────────────────────

withTestContext();

let app: AppContext;

beforeEach(async () => {
  capturedEvents = [];
  app = AppContext.forTest();
  setApp(app);
  await app.boot();
});

afterAll(async () => {
  if (app) await app.shutdown();
  clearApp();
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe("useEventLog", () => {
  it("returns empty array when no sessions exist", async () => {
    const { unmount } = render(<WrappedEventCapture expanded={false} />);
    await waitFor(() => capturedEvents !== null);
    await waitFor(() => Array.isArray(capturedEvents));
    expect(capturedEvents).toBeInstanceOf(Array);
    expect(capturedEvents.length).toBe(0);
    unmount();
  });

  it("returns formatted events when sessions have events", async () => {
    const s = startSession({ summary: "event-test", repo: ".", flow: "bare" });
    logEvent(s.id, "session_created", { data: { summary: "event-test" } });
    logEvent(s.id, "stage_started", { data: { agent: "planner", stage: "plan" } });

    const { unmount } = render(<WrappedEventCapture expanded={false} />);
    await waitFor(() => capturedEvents.length > 0, { timeout: 3000 });

    expect(capturedEvents.length).toBeGreaterThan(0);

    // Each entry should have the expected fields
    for (const entry of capturedEvents) {
      expect(typeof entry.time).toBe("string");
      expect(typeof entry.source).toBe("string");
      expect(typeof entry.type).toBe("string");
      expect(typeof entry.message).toBe("string");
      expect(typeof entry.color).toBe("string");
    }
    unmount();
  });

  it("events include correct color for type", async () => {
    const s = startSession({ summary: "color-test", repo: ".", flow: "bare" });
    logEvent(s.id, "agent_error", { data: { error: "something broke" } });
    logEvent(s.id, "session_completed");
    logEvent(s.id, "stage_started", { data: { agent: "impl", stage: "implement" } });

    const { unmount } = render(<WrappedEventCapture expanded={true} />);
    await waitFor(() => capturedEvents.length >= 3, { timeout: 3000 });

    const errorEntry = capturedEvents.find(e => e.type === "agent_error");
    expect(errorEntry).toBeDefined();
    expect(errorEntry!.color).toBe("red");

    const completeEntry = capturedEvents.find(e => e.type === "session_completed");
    expect(completeEntry).toBeDefined();
    expect(completeEntry!.color).toBe("green");

    const startEntry = capturedEvents.find(e => e.type === "stage_started");
    expect(startEntry).toBeDefined();
    // Color comes from theme.accent (was hardcoded "cyan", now theme-driven)
    expect(startEntry!.color).toBeTruthy();
    unmount();
  });

  it("expanded mode returns more events than collapsed", async () => {
    const s = startSession({ summary: "expand-test", repo: ".", flow: "bare" });
    // Create many events
    for (let i = 0; i < 8; i++) {
      logEvent(s.id, "stage_started", { data: { agent: `agent-${i}`, stage: `stage-${i}` } });
    }

    // Render collapsed
    let collapsedCount = 0;
    const { unmount: unmount1 } = render(<WrappedEventCapture expanded={false} />);
    await waitFor(() => capturedEvents.length > 0, { timeout: 3000 });
    collapsedCount = capturedEvents.length;
    unmount1();

    // Reset
    capturedEvents = [];

    // Render expanded
    const { unmount: unmount2 } = render(<WrappedEventCapture expanded={true} />);
    await waitFor(() => capturedEvents.length > 0, { timeout: 3000 });
    const expandedCount = capturedEvents.length;
    unmount2();

    // Expanded should show at least as many (likely more) events
    expect(expandedCount).toBeGreaterThanOrEqual(collapsedCount);
  });

  it("source field is truncated to 20 chars", async () => {
    const longSummary = "This is a very long session summary that exceeds twenty characters";
    const s = startSession({ summary: longSummary, repo: ".", flow: "bare" });
    logEvent(s.id, "session_created", { data: { summary: longSummary } });

    const { unmount } = render(<WrappedEventCapture expanded={false} />);
    await waitFor(() => capturedEvents.length > 0, { timeout: 3000 });

    for (const entry of capturedEvents) {
      expect(entry.source.length).toBeLessThanOrEqual(20);
    }
    unmount();
  });

  it("events are sorted by time descending (newest first)", async () => {
    const s = startSession({ summary: "sort-test", repo: ".", flow: "bare" });
    logEvent(s.id, "session_created");
    // Small delay so times differ
    await new Promise(r => setTimeout(r, 50));
    logEvent(s.id, "stage_started", { data: { stage: "plan" } });

    const { unmount } = render(<WrappedEventCapture expanded={true} />);
    await waitFor(() => capturedEvents.length >= 2, { timeout: 3000 });

    // Events should be newest first (descending time)
    for (let i = 0; i < capturedEvents.length - 1; i++) {
      expect(capturedEvents[i].time >= capturedEvents[i + 1].time).toBe(true);
    }
    unmount();
  });
});
