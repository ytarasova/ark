/**
 * Session-list filter pill row tests.
 *
 * Nit 1: the ACTIVE / DONE / ALL pill row read as cramped + off-balance --
 * the count digit looked like a separate line, ALL clipped against its oval,
 * and the Group-by-parent checkbox crowded the last pill.
 *
 * These tests pin the new layout choices:
 *   1. Each chip renders label + count inline (no concatenation, count gets
 *      its own tabular-nums span so it baselines against the label).
 *   2. The active chip gets the brand `--primary-subtle` fill + brand-color
 *      text + matching border.
 *   3. Inactive chips get a hairline `--border` ring so they read as
 *      discrete pills.
 *   4. The Group-by-parent toggle is separated from the chip group by a
 *      1px vertical rule, with `mx-[4px]`-ish breathing room.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import React from "react";
import { renderToString } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MockTransport } from "../../transport/MockTransport.js";
import { TransportProvider } from "../../transport/TransportContext.js";
import { setTransport } from "../../hooks/useApi.js";
import { SessionListPanel } from "../SessionList.js";
import { FilterChip } from "../ui/FilterChip.js";

let mock: MockTransport;

beforeEach(() => {
  mock = new MockTransport();
  setTransport(mock);
  // Reset localStorage so groupByParent default doesn't cross-contaminate.
  (globalThis as any).localStorage = {
    _data: {},
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
});

function renderPanel(sessions: any[] = []): string {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnMount: false } } });
  return renderToString(
    React.createElement(
      TransportProvider,
      { transport: mock },
      React.createElement(
        QueryClientProvider,
        { client: qc },
        React.createElement(SessionListPanel, {
          sessions,
          selectedId: null,
          onSelect: () => {},
          filter: "all",
          onFilterChange: () => {},
          search: "",
          onSearchChange: () => {},
          onNewSession: () => {},
          readOnly: false,
          groupByParent: false,
          onGroupByParentChange: () => {},
        }),
      ),
    ),
  );
}

describe("FilterChip pill atom", () => {
  test("active chip uses the brand --primary-subtle fill and matching text", () => {
    const html = renderToString(React.createElement(FilterChip, { label: "All", active: true }));
    expect(html).toContain("bg-[var(--primary-subtle)]");
    expect(html).toContain("text-[var(--primary)]");
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('data-active="true"');
  });

  test("inactive chip carries a hairline --border ring + muted-fg label", () => {
    const html = renderToString(React.createElement(FilterChip, { label: "Active", count: 3, active: false }));
    // Hairline border using the shared --border token.
    expect(html).toContain("border-[var(--border)]");
    // Default fg-muted text.
    expect(html).toContain("text-[var(--fg-muted)]");
    expect(html).toContain('aria-pressed="false"');
    expect(html).toContain('data-active="false"');
    // Count is its own tabular-nums span (so it baselines, not stacks).
    expect(html).toContain("tabular-nums");
    expect(html).toContain(">3<");
    expect(html).toContain(">Active<");
  });

  test("uppercase mono-ui treatment with 0.05em tracking matches the spec", () => {
    const html = renderToString(React.createElement(FilterChip, { label: "All", active: false }));
    expect(html).toContain("font-[family-name:var(--font-mono-ui)]");
    expect(html).toContain("text-[10px]");
    expect(html).toContain("uppercase");
    expect(html).toContain("tracking-[0.05em]");
    expect(html).toContain("px-[6px]");
    expect(html).toContain("py-[3px]");
  });
});

describe("SessionListPanel filter row layout", () => {
  test("renders Active/All chips with their counts as distinct spans", () => {
    const html = renderPanel([]);
    expect(html).toContain(">Active<");
    expect(html).toContain(">All<");
    // No concatenated 'Active 0' label slipping through (would defeat the
    // tabular-nums treatment for the count).
    expect(html).not.toContain(">Active 0<");
  });

  test("group-by-parent toggle is preceded by a 1px vertical rule separator", () => {
    const html = renderPanel([]);
    const ruleIdx = html.indexOf('class="ml-auto mr-[4px] h-[14px] w-px bg-[var(--border)] self-center"');
    const toggleIdx = html.indexOf('data-testid="group-by-parent-toggle"');
    expect(ruleIdx).toBeGreaterThan(-1);
    expect(toggleIdx).toBeGreaterThan(-1);
    expect(toggleIdx).toBeGreaterThan(ruleIdx);
  });
});
