/**
 * LogsTab SSR tests.
 *
 * bun:test has no DOM, so we render via `react-dom/server` -- same strategy
 * as `IntegrationsPage.test.tsx`. The react-query cache is pre-seeded with
 * the exact `["session-stdio", id, tail]` key the component uses so SSR
 * returns populated markup instead of the loading / empty state.
 *
 * Uses `MockTransport` too so the refetchInterval path still has a handler
 * registered even though SSR never fires it.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import React from "react";
import { renderToString } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MockTransport } from "../../../transport/MockTransport.js";
import { TransportProvider } from "../../../transport/TransportContext.js";
import { LogsTab } from "../tabs/LogsTab.js";

let mock: MockTransport;

function freshClient(
  seed: { content: string; size: number; exists: boolean },
  tail: number | "all" = 500,
): QueryClient {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnMount: false } } });
  qc.setQueryData(["session-stdio", "s-1", tail], seed);
  return qc;
}

beforeEach(() => {
  mock = new MockTransport();
  mock.register("session/stdio", () => ({ content: "", size: 0, exists: false }));
});

afterEach(() => {
  /* per-test QueryClient */
});

function render(opts: {
  content: string;
  size?: number;
  exists?: boolean;
  status?: string;
  tail?: number | "all";
}): string {
  const qc = freshClient(
    { content: opts.content, size: opts.size ?? opts.content.length, exists: opts.exists ?? true },
    opts.tail ?? 500,
  );
  return renderToString(
    React.createElement(
      TransportProvider,
      { transport: mock },
      React.createElement(
        QueryClientProvider,
        { client: qc },
        React.createElement(LogsTab, { sessionId: "s-1", status: opts.status ?? "completed" }),
      ),
    ),
  );
}

describe("LogsTab", () => {
  test("renders the terminal-panel header with session id chip + traffic dots", () => {
    const html = render({ content: "line1\nline2\n" });
    expect(html).toContain('data-testid="logs-tab"');
    expect(html).toContain('data-testid="logs-header-chip"');
    // React SSR inserts `<!-- -->` comment nodes between text + expression siblings.
    expect(html).toMatch(/stdio ·.*s-1/);
  });

  test("renders log lines with line numbers", () => {
    const html = render({ content: "alpha\nbeta\ngamma\n" });
    expect(html).toContain('data-testid="logs-body"');
    expect(html).toContain("alpha");
    expect(html).toContain("beta");
    expect(html).toContain("gamma");
    // Line-number gutter -- 1, 2, 3 must be present.
    expect(html).toMatch(/>1<\/span>/);
    expect(html).toMatch(/>2<\/span>/);
    expect(html).toMatch(/>3<\/span>/);
  });

  test("styles [exec ...] prefix lines with the muted class", () => {
    const html = render({ content: "[exec bash] ls\nhello\n" });
    // Both lines render; the [exec bash] line is on a span with the muted fg
    // colour class. Assert both the text and the class are present in the
    // same markup chunk.
    expect(html).toContain("[exec bash] ls");
    expect(html).toContain("text-[var(--fg-muted)]");
  });

  test("shows the 'No logs yet' empty state when the file is missing and surfaces the status", () => {
    const html = render({ content: "", exists: false, size: 0, status: "running" });
    expect(html).toContain('data-testid="logs-empty"');
    expect(html).toContain("No logs yet");
    expect(html).toMatch(/status ·.*running/);
  });

  test("shows the live indicator when the session is still running", () => {
    const html = render({ content: "...", status: "running" });
    expect(html).toContain('data-testid="logs-live-indicator"');
  });

  test("hides the live indicator on terminal states (completed/failed/stopped/archived)", () => {
    for (const st of ["completed", "failed", "stopped", "archived"]) {
      const html = render({ content: "...", status: st });
      expect(html).not.toContain('data-testid="logs-live-indicator"');
    }
  });

  test("tail toggle renders with the default 'Last 500' label", () => {
    const html = render({ content: "x" });
    expect(html).toContain('data-testid="logs-tail-toggle"');
    expect(html).toContain("Last 500");
  });

  test("autoscroll toggle is checked by default", () => {
    const html = render({ content: "x" });
    expect(html).toContain('data-testid="logs-autoscroll-toggle"');
    // The input is rendered with `checked` attr in SSR when the React prop is true.
    const match = html.match(/data-testid="logs-autoscroll-toggle"[^>]*checked/);
    expect(match).not.toBeNull();
  });
});
