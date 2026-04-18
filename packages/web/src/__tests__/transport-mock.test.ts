/**
 * Smoke test: MockTransport implements WebTransport and flows through
 * TransportProvider + useTransport so unit tests can stub RPC responses.
 *
 * We render a trivial component via react-dom/server (no DOM required)
 * that reads the transport from context and spits out the method it was
 * asked to call. This is the minimum proof that the context wiring works.
 * Broader hook coverage is a separate follow-up.
 */

import { describe, test, expect } from "bun:test";
import React from "react";
import { renderToString } from "react-dom/server";
import { MockTransport } from "../transport/MockTransport.js";
import { TransportProvider, useTransport } from "../transport/TransportContext.js";

function Probe({ onResult }: { onResult: (s: string) => void }) {
  const t = useTransport();
  // The probe exercises two surfaces: type identity (MockTransport) and a live rpc call.
  void (async () => {
    const out = await t.rpc<{ echo: string }>("test/echo", { say: "hi" });
    onResult(`echoed:${out.echo}`);
  })();
  return React.createElement("div", { "data-kind": "probe" }, "probe-rendered");
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

  test("TransportProvider makes MockTransport available via useTransport()", () => {
    const mock = new MockTransport();
    mock.register("test/echo", (params) => ({ echo: params.say }));

    let captured: string | null = null;
    const tree = React.createElement(
      TransportProvider,
      { transport: mock },
      React.createElement(Probe, { onResult: (s: string) => (captured = s) }),
    );

    const html = renderToString(tree);
    expect(html).toContain("probe-rendered");
    // The probe enqueued an rpc() call synchronously; record it.
    expect(mock.calls.length).toBe(1);
    expect(mock.calls[0].method).toBe("test/echo");
    // captured is populated asynchronously; we only assert the rpc() was routed.
    void captured;
  });

  test("TransportProvider sets the module-level transport so `api.*` routes through it", async () => {
    const mock = new MockTransport();
    mock.register("session/list", () => ({ sessions: [{ id: "s-abc", status: "ok" }] }));

    // Synchronously mount a provider -- setTransport() fires during render.
    const tree = React.createElement(TransportProvider, { transport: mock }, React.createElement("div"));
    renderToString(tree);

    const { api } = await import("../hooks/useApi.js");
    const sessions = await api.getSessions();
    expect(sessions).toEqual([{ id: "s-abc", status: "ok" }]);
    expect(mock.calls[0].method).toBe("session/list");
  });
});
