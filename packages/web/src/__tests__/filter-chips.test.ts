/**
 * Tests for session count/filter logic used with FilterChip.
 *
 * The counting and filtering logic lives in SessionListPanel (SessionList.tsx).
 * We duplicate the pure functions here to test independently of React rendering.
 */

import { describe, test, expect } from "bun:test";

// ---------------------------------------------------------------------------
// Extracted logic from SessionList.tsx
// ---------------------------------------------------------------------------

interface StatusCounts {
  running: number;
  waiting: number;
  completed: number;
  failed: number;
}

function computeCounts(sessions: any[]): StatusCounts {
  const c = { running: 0, waiting: 0, completed: 0, failed: 0 };
  for (const s of sessions || []) {
    if (s.status === "running") c.running++;
    else if (s.status === "waiting") c.waiting++;
    else if (s.status === "completed") c.completed++;
    else if (s.status === "failed") c.failed++;
  }
  return c;
}

function filterSessions(sessions: any[], filter: string, search: string): any[] {
  let list = sessions || [];
  if (filter !== "all") list = list.filter((s) => s.status === filter);
  if (search) {
    const q = search.toLowerCase();
    list = list.filter(
      (s) =>
        (s.summary || "").toLowerCase().includes(q) ||
        (s.id || "").toLowerCase().includes(q) ||
        (s.agent || "").toLowerCase().includes(q),
    );
  }
  return list;
}

/** Simulate clicking a chip: if the current filter matches, clear to "all"; otherwise set it. */
function toggleFilter(current: string, clicked: string): string {
  return current === clicked ? "all" : clicked;
}

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

const SESSIONS = [
  { id: "s-01", status: "running", summary: "Build feature A", agent: "coder" },
  { id: "s-02", status: "running", summary: "Build feature B", agent: "planner" },
  { id: "s-03", status: "waiting", summary: "Review PR #42", agent: "reviewer" },
  { id: "s-04", status: "completed", summary: "Deploy v1.0", agent: "deployer" },
  { id: "s-05", status: "completed", summary: "Deploy v1.1", agent: "deployer" },
  { id: "s-06", status: "completed", summary: "Deploy v1.2", agent: "deployer" },
  { id: "s-07", status: "failed", summary: "Broken migration", agent: "coder" },
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("computeCounts", () => {
  test("counts running/waiting/completed/failed correctly", () => {
    const counts = computeCounts(SESSIONS);
    expect(counts.running).toBe(2);
    expect(counts.waiting).toBe(1);
    expect(counts.completed).toBe(3);
    expect(counts.failed).toBe(1);
  });

  test("zero counts for empty sessions", () => {
    const counts = computeCounts([]);
    expect(counts.running).toBe(0);
    expect(counts.waiting).toBe(0);
    expect(counts.completed).toBe(0);
    expect(counts.failed).toBe(0);
  });

  test("zero counts for null/undefined sessions", () => {
    const counts = computeCounts(null as any);
    expect(counts.running).toBe(0);
    expect(counts.waiting).toBe(0);
    expect(counts.completed).toBe(0);
    expect(counts.failed).toBe(0);
  });

  test("sessions with non-standard statuses are not counted", () => {
    const sessions = [
      { id: "s-10", status: "ready" },
      { id: "s-11", status: "archived" },
      { id: "s-12", status: "blocked" },
      { id: "s-13", status: "running" },
    ];
    const counts = computeCounts(sessions);
    expect(counts.running).toBe(1);
    expect(counts.waiting).toBe(0);
    expect(counts.completed).toBe(0);
    expect(counts.failed).toBe(0);
  });
});

describe("filterSessions", () => {
  test("filter 'all' returns all sessions", () => {
    const result = filterSessions(SESSIONS, "all", "");
    expect(result).toHaveLength(7);
  });

  test("clicking a chip filters the session list by status", () => {
    const running = filterSessions(SESSIONS, "running", "");
    expect(running).toHaveLength(2);
    expect(running.every((s) => s.status === "running")).toBe(true);

    const completed = filterSessions(SESSIONS, "completed", "");
    expect(completed).toHaveLength(3);
    expect(completed.every((s) => s.status === "completed")).toBe(true);

    const failed = filterSessions(SESSIONS, "failed", "");
    expect(failed).toHaveLength(1);
    expect(failed[0].summary).toBe("Broken migration");
  });

  test("clicking active chip clears filter (back to all)", () => {
    // Simulate: filter is currently "running", user clicks "running" again
    const newFilter = toggleFilter("running", "running");
    expect(newFilter).toBe("all");

    const result = filterSessions(SESSIONS, newFilter, "");
    expect(result).toHaveLength(7);
  });

  test("clicking a different chip switches filter", () => {
    const newFilter = toggleFilter("running", "completed");
    expect(newFilter).toBe("completed");
  });

  test("search combines with status filter", () => {
    const result = filterSessions(SESSIONS, "completed", "v1.1");
    expect(result).toHaveLength(1);
    expect(result[0].summary).toBe("Deploy v1.1");
  });

  test("search matches against id, summary, and agent", () => {
    // Match by agent name
    const byAgent = filterSessions(SESSIONS, "all", "deployer");
    expect(byAgent).toHaveLength(3);

    // Match by session ID
    const byId = filterSessions(SESSIONS, "all", "s-07");
    expect(byId).toHaveLength(1);
    expect(byId[0].summary).toBe("Broken migration");
  });

  test("filter with no matches returns empty array", () => {
    const result = filterSessions(SESSIONS, "waiting", "nonexistent");
    expect(result).toHaveLength(0);
  });
});
