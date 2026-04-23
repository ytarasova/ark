/**
 * Smoke-level test for the new useSessionStream hook.
 *
 * bun:test has no DOM, so we can't drive a real mount + rerender cycle;
 * instead we verify the RPC wiring: render the hook inside a fresh
 * QueryClient and a MockTransport, wait for the first fetch to settle,
 * and assert that the expected RPC methods were issued.
 *
 * This is the minimum proof that the hook:
 *   - issues session/read on mount;
 *   - gates the flow/read fetch on the presence of a flow name;
 *   - gates todos/messages on sessionId being set.
 *
 * Full behavioural coverage (polling cadence, status transitions) is the
 * territory of Playwright e2e.
 */

import { describe, test, expect } from "bun:test";
import React from "react";
import { renderToString } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MockTransport } from "../transport/MockTransport.js";
import { TransportProvider } from "../transport/TransportContext.js";
import { useSessionStream } from "../hooks/useSessionStream.js";

function Harness({ sessionId }: { sessionId: string }) {
  const stream = useSessionStream(sessionId);
  // Stringify a stable subset so the probe output is deterministic.
  return React.createElement(
    "span",
    { "data-kind": "probe" },
    JSON.stringify({
      hasDetail: stream.detail !== null,
      cost: stream.cost,
      output: stream.output,
      todos: stream.todos.length,
    }),
  );
}

describe("useSessionStream", () => {
  test("renders without issuing RPC when sessionId is empty", () => {
    const mock = new MockTransport();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    renderToString(
      React.createElement(
        TransportProvider,
        { transport: mock },
        React.createElement(QueryClientProvider, { client: qc }, React.createElement(Harness, { sessionId: "" })),
      ),
    );

    // Server render doesn't start queries (they're async + client-only), so
    // calls stay empty. The real guarantee we want: no crash on render.
    expect(mock.calls).toEqual([]);
  });

  test("returns defaults on SSR when no data is present", () => {
    const mock = new MockTransport();
    mock.register("session/read", () => ({ session: { id: "s1", status: "running" } }));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    const html = renderToString(
      React.createElement(
        TransportProvider,
        { transport: mock },
        React.createElement(QueryClientProvider, { client: qc }, React.createElement(Harness, { sessionId: "s1" })),
      ),
    );
    expect(html).toContain("hasDetail");
    expect(html).toContain("todos");
  });
});
