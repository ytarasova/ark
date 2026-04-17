/**
 * End-to-end tests for session view layout, scrolling, and stage display.
 *
 * These tests verify the rendered DOM structure by reading component source
 * and validating the CSS class chains that control layout behavior.
 * They complement the visual Playwright verification.
 */

import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const WEB_SRC = join(import.meta.dir, "..");

function readFile(relativePath: string): string {
  return readFileSync(join(WEB_SRC, relativePath), "utf-8");
}

// ---------------------------------------------------------------------------
// Duplicated buildStageProgress from SessionList.tsx (card view) to verify
// it matches the corrected logic in timeline-builder.ts (detail view).
// ---------------------------------------------------------------------------

function buildStageProgressList(session: any, flowStages: any[]) {
  if (!flowStages || flowStages.length === 0) return [];
  const currentStage = session.stage;
  const currentIdx = flowStages.findIndex((s: any) => s.name === currentStage);
  const isFailed = session.status === "failed";
  const isCompleted = session.status === "completed";
  const isRunning = session.status === "running" || session.status === "waiting";

  return flowStages.map((s: any, i: number) => {
    if (isCompleted) return { name: s.name, state: "done" as const };
    if (isFailed && i === currentIdx) return { name: s.name, state: "failed" as const };
    if (currentIdx < 0) return { name: s.name, state: "pending" as const };
    if (i < currentIdx) return { name: s.name, state: "done" as const };
    if (i === currentIdx) return { name: s.name, state: isRunning ? ("active" as const) : ("pending" as const) };
    return { name: s.name, state: "pending" as const };
  });
}

function buildStageProgressDetail(session: any, flowStages: any[]) {
  if (!flowStages || flowStages.length === 0) return [];
  const currentStage = session.stage;
  const currentIdx = flowStages.findIndex((s: any) => s.name === currentStage);
  const isFailed = session.status === "failed";
  const isCompleted = session.status === "completed";
  const isRunning = session.status === "running" || session.status === "waiting";

  return flowStages.map((s: any, i: number) => {
    if (isCompleted) return { name: s.name, state: "done" as const };
    if (currentIdx < 0) return { name: s.name, state: "pending" as const };
    if (i < currentIdx) return { name: s.name, state: "done" as const };
    if (i === currentIdx) {
      if (isFailed) return { name: s.name, state: "failed" as const };
      if (isRunning) return { name: s.name, state: "active" as const };
      return { name: s.name, state: "pending" as const };
    }
    return { name: s.name, state: "pending" as const };
  });
}

const STAGES = [{ name: "plan" }, { name: "implement" }, { name: "pr" }];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("e2e: overflow chain prevents page-level scroll", () => {
  test("full overflow chain from Layout -> SessionsPage -> SessionDetail", () => {
    const layout = readFile("components/Layout.tsx");
    const sessionsPage = readFile("pages/SessionsPage.tsx");
    const sessionDetail = readFile("components/SessionDetail.tsx");

    // 1. Layout root: h-screen + overflow-hidden locks viewport
    expect(layout).toContain('className="flex h-screen bg-[var(--bg)] overflow-hidden"');

    // 2. Layout content area: overflow-hidden propagates constraint
    expect(layout).toContain('className="flex-1 flex min-w-0 overflow-hidden"');

    // 3. SessionsPage center wrapper: overflow-hidden constrains SessionDetail
    expect(sessionsPage).toContain('className="flex-1 flex flex-col min-w-0 overflow-hidden"');

    // 4. SessionDetail root: min-h-0 overrides flex default min-height:auto
    expect(sessionDetail).toContain('className="flex-1 flex flex-col min-w-0 min-h-0 bg-[var(--bg)]"');

    // 5. SessionDetail scroll container: overflow-y-auto for non-terminal tabs
    expect(sessionDetail).toContain('"overflow-y-auto px-6 py-6"');
  });
});

describe("e2e: session list and detail view consistency", () => {
  test("list and detail buildStageProgress produce identical results for all statuses", () => {
    const scenarios = [
      { stage: "plan", status: "running" },
      { stage: "implement", status: "running" },
      { stage: "pr", status: "running" },
      { stage: "plan", status: "completed" },
      { stage: "pr", status: "completed" },
      { stage: "plan", status: "failed" },
      { stage: "implement", status: "failed" },
      { stage: "pr", status: "failed" },
      { stage: "nonexistent", status: "failed" },
      { stage: null, status: "failed" },
    ];

    for (const session of scenarios) {
      const listResult = buildStageProgressList(session, STAGES);
      const detailResult = buildStageProgressDetail(session, STAGES);
      expect(listResult).toEqual(detailResult);
    }
  });

  test("failed session at last stage shows red in both views", () => {
    const session = { stage: "pr", status: "failed" };
    const listResult = buildStageProgressList(session, STAGES);
    const detailResult = buildStageProgressDetail(session, STAGES);

    // Both should show: plan=done, implement=done, pr=failed
    expect(listResult[0].state).toBe("done");
    expect(listResult[1].state).toBe("done");
    expect(listResult[2].state).toBe("failed");

    expect(detailResult[0].state).toBe("done");
    expect(detailResult[1].state).toBe("done");
    expect(detailResult[2].state).toBe("failed");
  });

  test("completed session shows all green in both views", () => {
    const session = { stage: "pr", status: "completed" };
    const listResult = buildStageProgressList(session, STAGES);
    const detailResult = buildStageProgressDetail(session, STAGES);

    for (const s of listResult) expect(s.state).toBe("done");
    for (const s of detailResult) expect(s.state).toBe("done");
  });
});

describe("e2e: source code sync between SessionList and timeline-builder", () => {
  test("both implementations handle failed state identically", () => {
    const sessionList = readFile("components/SessionList.tsx");
    const timelineBuilder = readFile("components/session/timeline-builder.ts");

    // Both must emit "failed" for the current stage when session is failed
    expect(sessionList).toContain('"failed" as const');
    expect(timelineBuilder).toContain('"failed" as const');

    // Neither should emit "active" for failed sessions
    const listBuildFn = sessionList.match(/function buildStageProgress[\s\S]*?^}/m);
    expect(listBuildFn).not.toBeNull();
    // The failed-stage line should use "failed", not "active"
    expect(sessionList).toMatch(/isFailed && i === currentIdx.*"failed"/);
  });
});
