/**
 * Smoke test: MockTransport implements WebTransport and flows through
 * TransportProvider + useTransport/useApi so unit tests can stub RPC responses.
 *
 * We render probes via react-dom/server (no DOM required). The critical
 * invariant, now that the module-level transport singleton is gone, is that
 * two sibling TransportProviders in the same render tree each route through
 * their own transport -- the scope-isolation regression test at the bottom of
 * this file covers that explicitly.
 */

import { describe, test, expect } from "bun:test";
import React from "react";
import { renderToString } from "react-dom/server";
import { MockTransport } from "../transport/MockTransport.js";
import { TransportProvider, useTransport } from "../transport/TransportContext.js";
import { useApi } from "../hooks/useApi.js";

function TransportProbe({ onResult }: { onResult: (s: string) => void }) {
  const t = useTransport();
  // The probe exercises two surfaces: type identity (MockTransport) and a live rpc call.
  void (async () => {
    const out = await t.rpc<{ echo: string }>("test/echo", { say: "hi" });
    onResult(`echoed:${out.echo}`);
  })();
  return React.createElement("div", { "data-kind": "probe" }, "probe-rendered");
}

/**
 * Fires a `session/list` call through `useApi()` on every render. Used below
 * to prove the `useApi()` hook routes through whatever transport its enclosing
 * TransportProvider supplies.
 */
function ApiProbe() {
  const api = useApi();
  void api.getSessions();
  return React.createElement("div", { "data-kind": "api-probe" }, "api-probe-rendered");
}

describe("MockTransport smoke", () => {
  test("rpc() returns whatever the registered handler yields", async () => {
    const mock = new MockTransport();
    mock.register("test/echo", (params) => ({ echo: params.say }));

    const result = await mock.rpc<{ echo: string }>("test/echo", { say: "hello" });
    expect(result.echo).toBe("hello");
    expect(mock.calls).toEqual([{ method: "test/echo", params: { say: "hello" } }]);
  });

  test("unregistered methods reject with a helpful error", async () => {
    const mock = new MockTransport();
    await expect(mock.rpc("nope/never", {})).rejects.toThrow(/no handler/);
  });

  test("createEventSource returns a usable stub without network", () => {
    const mock = new MockTransport();
    const es = mock.createEventSource("/api/events/stream");
    expect(es.url).toBe("mock:///api/events/stream");
    // close() must not throw on the stub.
    es.close();
  });

  test("setToken() records the token for assertion without hitting the network", () => {
    const mock = new MockTransport();
    expect(mock.token).toBeNull();
    mock.setToken("abc123");
    expect(mock.token).toBe("abc123");
    mock.setToken(null);
    expect(mock.token).toBeNull();
  });

  test("TransportProvider makes MockTransport available via useTransport()", () => {
    const mock = new MockTransport();
    mock.register("test/echo", (params) => ({ echo: params.say }));

    let captured: string | null = null;
    const tree = React.createElement(
      TransportProvider,
      { transport: mock },
      React.createElement(TransportProbe, { onResult: (s: string) => (captured = s) }),
    );

    const html = renderToString(tree);
    expect(html).toContain("probe-rendered");
    // The probe enqueued an rpc() call synchronously; record it.
    expect(mock.calls.length).toBe(1);
    expect(mock.calls[0].method).toBe("test/echo");
    // captured is populated asynchronously; we only assert the rpc() was routed.
    void captured;
  });

  test("useApi() routes through the nearest TransportProvider", () => {
    const mock = new MockTransport();
    mock.register("session/list", () => ({ sessions: [{ id: "s-abc", status: "ok" }] }));

    const tree = React.createElement(TransportProvider, { transport: mock }, React.createElement(ApiProbe));
    const html = renderToString(tree);
    expect(html).toContain("api-probe-rendered");
    expect(mock.calls.length).toBe(1);
    expect(mock.calls[0].method).toBe("session/list");
  });

  // ── Scope isolation ────────────────────────────────────────────────────────
  // This is THE test that proves the module-level singleton is gone. Two
  // sibling TransportProviders each wire their own MockTransport; an ApiProbe
  // inside each subtree must route to its own scope's transport.
  test("sibling TransportProviders route useApi() calls to their own transport", () => {
    const mockA = new MockTransport();
    const mockB = new MockTransport();
    mockA.register("session/list", () => ({ sessions: [{ id: "from-a" }] }));
    mockB.register("session/list", () => ({ sessions: [{ id: "from-b" }] }));

    const tree = React.createElement(
      "div",
      null,
      React.createElement(TransportProvider, { transport: mockA }, React.createElement(ApiProbe)),
      React.createElement(TransportProvider, { transport: mockB }, React.createElement(ApiProbe)),
    );
    renderToString(tree);

    expect(mockA.calls.length).toBe(1);
    expect(mockA.calls[0].method).toBe("session/list");
    expect(mockB.calls.length).toBe(1);
    expect(mockB.calls[0].method).toBe("session/list");
    // Neither transport saw the other's call -- the singleton leak is closed.
  });
});
