/**
 * useSessionDetail tab list tests.
 *
 * Verifies the 6-top-level-tabs layout (Timeline, Flow, Files, Logs,
 * Terminal, Cost) plus the conditional "Errors" tab. The Timeline tab (id
 * `conversation`) absorbed the former Events tab -- its rows now open the
 * raw-event drawer directly, so a dedicated Events tab was duplication.
 * "Files" is the rebadged Diff tab (the standalone Files list was redundant
 * since DiffViewer's internal file picker already enumerates them).
 *
 * SSR-renders a tiny probe component that calls the hook and stamps the
 * resulting tab ids into the DOM, then asserts on the markup -- same
 * pattern used by the SessionListTree + LogsTab tests.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import React from "react";
import { renderToString } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MockTransport } from "../../transport/MockTransport.js";
import { TransportProvider } from "../../transport/TransportContext.js";
import { useSessionDetail } from "../useSessionDetail.js";

let mock: MockTransport;

beforeEach(() => {
  mock = new MockTransport();
  // Register no-op handlers so any background fetch fails loudly rather than
  // hanging during SSR.
  mock.register("session/get", () => ({ session: null, events: [] }));
  mock.register("session/todos", () => []);
  mock.register("session/messages", () => ({ messages: [] }));
  mock.register("session/cost_totals", () => null);
  mock.register("session/stdio", () => ({ content: "", size: 0, exists: false }));
});

afterEach(() => {
  /* per-test QueryClient */
});

interface ProbeOpts {
  status: string;
  hasErrors?: boolean;
}

function Probe({ status, hasErrors }: ProbeOpts) {
  const session = {
    id: "s-1",
    status,
    summary: "test",
    agent: "claude",
    flow: "quick",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  const events = hasErrors ? [{ type: "error", data: { error: "boom" }, created_at: new Date().toISOString() }] : [];
  const qc = (Probe as any)._qc as QueryClient;
  qc.setQueryData(["session", "s-1"], { session, events });
  qc.setQueryData(["session", "s-1", "todos"], []);
  qc.setQueryData(["session", "s-1", "messages"], []);
  qc.setQueryData(["session", "s-1", "cost"], null);

  const d = useSessionDetail({ sessionId: "s-1" });
  return (
    <ul data-testid="tab-list">
      {d.tabs.map((t) => (
        <li key={t.id} data-tab-id={t.id}>
          {t.label}
        </li>
      ))}
    </ul>
  );
}

function render(opts: ProbeOpts): string {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnMount: false, refetchOnWindowFocus: false } },
  });
  (Probe as any)._qc = qc;
  return renderToString(
    React.createElement(
      TransportProvider,
      { transport: mock },
      React.createElement(QueryClientProvider, { client: qc }, React.createElement(Probe, opts)),
    ),
  );
}

function tabIds(html: string): string[] {
  const matches = [...html.matchAll(/data-tab-id="([^"]+)"/g)];
  return matches.map((m) => m[1]);
}

describe("useSessionDetail tab list", () => {
  test("renders 6 top-level tabs in the documented order", () => {
    const html = render({ status: "running" });
    const ids = tabIds(html);
    expect(ids).toEqual(["conversation", "flow", "diff", "logs", "terminal", "cost"]);
    expect(ids).toHaveLength(6);
    expect(ids).not.toContain("files");
    expect(ids).not.toContain("knowledge");
    expect(ids).not.toContain("events");
  });

  test("appends Errors tab when the session has error events", () => {
    const html = render({ status: "failed", hasErrors: true });
    const ids = tabIds(html);
    expect(ids).toEqual(["conversation", "flow", "diff", "logs", "terminal", "cost", "errors"]);
    expect(ids).toHaveLength(7);
  });

  test("Errors tab still appears when status alone is failed", () => {
    const html = render({ status: "failed" });
    const ids = tabIds(html);
    expect(ids[ids.length - 1]).toBe("errors");
  });
});
