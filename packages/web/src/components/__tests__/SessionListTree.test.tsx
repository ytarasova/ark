/**
 * SessionListPanel tree-mode SSR tests.
 *
 * Same strategy as `LogsTab.test.tsx`: render via `react-dom/server`, pre-seed
 * the react-query cache at the keys the component reads, and use a
 * `MockTransport` so any live fetches fail loudly rather than hanging.
 *
 * We cover the three observable pieces that matter for the parent/child
 * tree treatment:
 *   1. The toolbar exposes a "Group by parent" toggle.
 *   2. A parent with children renders a chevron + `child_stats` rollup chip.
 *   3. When expanded, the children fetched via `session/list_children`
 *      appear indented below the parent.
 *   4. Child rows that are themselves roots in the flat list (i.e. have
 *      `parent_id`) surface a parent breadcrumb chip.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import React from "react";
import { renderToString } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MockTransport } from "../../transport/MockTransport.js";
import { TransportProvider } from "../../transport/TransportContext.js";
import { SessionListPanel } from "../SessionList.js";

let mock: MockTransport;

beforeEach(() => {
  mock = new MockTransport();
});

interface RenderOpts {
  sessions: any[];
  expanded?: string[];
  childrenById?: Record<string, any[]>;
  groupByParent?: boolean;
}

function render(opts: RenderOpts): string {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnMount: false } } });

  // Pre-seed the children queries so expanded parents render their children
  // synchronously during SSR (there's no microtask tick to wait on).
  for (const [id, kids] of Object.entries(opts.childrenById ?? {})) {
    qc.setQueryData(["session-children", id], kids);
    mock.register("session/list_children", () => ({ sessions: kids }));
  }

  // Prime localStorage with the expanded-ids set before first render so the
  // hydration picks up the right open state.
  if (opts.expanded) {
    (globalThis as any).localStorage = {
      _data: {
        "ark:sessionList:expanded": JSON.stringify(opts.expanded),
        "ark:sessionList:groupByParent": opts.groupByParent === false ? "0" : "1",
      },
      getItem(k: string) {
        return this._data[k] ?? null;
      },
      setItem(k: string, v: string) {
        this._data[k] = v;
      },
      removeItem(k: string) {
        delete this._data[k];
      },
    };
  }

  return renderToString(
    React.createElement(
      TransportProvider,
      { transport: mock },
      React.createElement(
        QueryClientProvider,
        { client: qc },
        React.createElement(SessionListPanel, {
          sessions: opts.sessions,
          selectedId: null,
          onSelect: () => {},
          filter: "all",
          onFilterChange: () => {},
          search: "",
          onSearchChange: () => {},
          onNewSession: () => {},
          readOnly: false,
          groupByParent: opts.groupByParent ?? true,
          onGroupByParentChange: () => {},
        }),
      ),
    ),
  );
}

describe("SessionListPanel tree mode", () => {
  test("renders the Group by parent toggle in the toolbar", () => {
    const html = render({ sessions: [] });
    expect(html).toContain('data-testid="group-by-parent-toggle"');
  });

  test("parent with children renders a chevron and child_stats rollup chip", () => {
    const parent = {
      id: "s-root",
      status: "running",
      summary: "Parent root",
      flow: "fan-out",
      agent: "claude",
      updated_at: new Date().toISOString(),
      parent_id: null,
      child_stats: { total: 3, running: 2, completed: 1, failed: 0, cost_usd_sum: 0.42 },
    };
    const html = render({ sessions: [parent] });
    // Tree row wrapper carries a data-testid we can assert on.
    expect(html).toContain('data-testid="session-tree-row"');
    expect(html).toContain('data-testid="tree-chevron"');
    expect(html).toContain('data-testid="child-stats-chip"');
    // The rollup chip surfaces the running/completed counts as text.
    expect(html).toMatch(/>2</);
    expect(html).toMatch(/>1</);
    // Cost formatting uses a dollar sign; rough check.
    expect(html).toContain("$");
  });

  test("expanded parent renders children indented below", () => {
    const parent = {
      id: "s-root",
      status: "running",
      summary: "Parent root",
      flow: "fan-out",
      agent: "claude",
      updated_at: new Date().toISOString(),
      parent_id: null,
      child_stats: { total: 3, running: 1, completed: 2, failed: 0, cost_usd_sum: 0 },
    };
    const child = (i: number, status = "completed") => ({
      id: `s-child-${i}`,
      status,
      summary: `Child ${i}`,
      flow: "fan-out",
      agent: "claude",
      updated_at: new Date().toISOString(),
      parent_id: "s-root",
      child_stats: null,
    });
    const children = [child(1), child(2), child(3, "running")];
    const html = render({
      sessions: [parent],
      expanded: ["s-root"],
      childrenById: { "s-root": children },
    });
    // Each child renders its own tree row with depth=1.
    expect(html).toContain('data-session-id="s-child-1"');
    expect(html).toContain('data-session-id="s-child-2"');
    expect(html).toContain('data-session-id="s-child-3"');
    expect(html).toContain('data-depth="1"');
    expect(html).toContain('data-testid="tree-children"');
  });

  test("root rows whose session has a parent_id surface a parent breadcrumb chip", () => {
    const orphanChild = {
      id: "s-child",
      status: "completed",
      summary: "Orphan search hit",
      flow: "fan-out",
      agent: "claude",
      updated_at: new Date().toISOString(),
      parent_id: "s-root-missing",
      parent_summary: "Parent root",
      child_stats: null,
    };
    const html = render({ sessions: [orphanChild] });
    expect(html).toContain('data-testid="parent-breadcrumb-chip"');
    // chip contains parent's summary.
    expect(html).toContain("Parent root");
  });

  test("non-tree mode (group-by-parent off) skips tree rows", () => {
    const s = {
      id: "s-1",
      status: "running",
      summary: "Flat row",
      flow: "quick",
      agent: "claude",
      updated_at: new Date().toISOString(),
      parent_id: null,
      child_stats: null,
    };
    const html = render({ sessions: [s], groupByParent: false });
    expect(html).not.toContain('data-testid="session-tree-row"');
    expect(html).toContain("Flat row");
  });
});
