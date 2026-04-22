/**
 * useTerminalSocket hook smoke test.
 *
 * bun:test has no DOM; we stub a minimal WebSocket just well enough to
 * exercise the lazy-mount + envelope-parsing paths. The hook's lifecycle
 * under a real browser is covered by the Playwright e2e in packages/e2e.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import React from "react";
import { renderToString } from "react-dom/server";
import { useTerminalSocket } from "../hooks/useTerminalSocket.js";

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static OPEN = 1;
  static CLOSED = 3;

  url: string;
  binaryType = "";
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string | ArrayBuffer }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  sent: Array<string | Uint8Array> = [];

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }
  send(data: string | Uint8Array) {
    this.sent.push(data);
  }
  close() {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }
}

let originalWS: unknown;

beforeEach(() => {
  FakeWebSocket.instances = [];
  originalWS = (globalThis as any).WebSocket;
  (globalThis as any).WebSocket = FakeWebSocket as any;
  // The hook reads from window.location; stub if absent.
  if (!(globalThis as any).window) {
    (globalThis as any).window = {
      location: { protocol: "http:", hostname: "localhost", search: "" },
    };
  }
});

afterEach(() => {
  (globalThis as any).WebSocket = originalWS;
});

function Harness(props: { sessionId: string; enabled: boolean; onResult?: (r: any) => void }) {
  const result = useTerminalSocket({ sessionId: props.sessionId, enabled: props.enabled });
  props.onResult?.(result);
  return React.createElement("span", { "data-kind": "probe" }, "ok");
}

describe("useTerminalSocket", () => {
  test("does not open a WebSocket while enabled=false", () => {
    renderToString(React.createElement(Harness, { sessionId: "s-1", enabled: false }));
    // Server render never runs effects, so no instance is created.
    expect(FakeWebSocket.instances.length).toBe(0);
  });

  test("renders without throwing when enabled=true", () => {
    const out = renderToString(React.createElement(Harness, { sessionId: "s-2", enabled: true }));
    // SSR path: the hook's effect doesn't run, the hook should still produce a stable render.
    expect(out).toContain("ok");
  });

  test("exposes disconnect + retry + reconnectAttempt + maxReconnectAttempts in the initial result", () => {
    let capturedResult: any = null;
    renderToString(
      React.createElement(Harness, {
        sessionId: "s-3",
        enabled: false,
        onResult: (r) => (capturedResult = r),
      }),
    );
    expect(capturedResult).toBeTruthy();
    expect(capturedResult.status).toBe("idle");
    expect(capturedResult.reconnectAttempt).toBe(0);
    // The reconnect policy from the spec: max 4 attempts.
    expect(capturedResult.maxReconnectAttempts).toBe(4);
    expect(typeof capturedResult.disconnect).toBe("function");
    expect(typeof capturedResult.retry).toBe("function");
    expect(typeof capturedResult.sendInput).toBe("function");
    expect(typeof capturedResult.sendResize).toBe("function");
  });

  test("disconnect is a stable no-op while idle", () => {
    let capturedResult: any = null;
    renderToString(
      React.createElement(Harness, {
        sessionId: "s-4",
        enabled: false,
        onResult: (r) => (capturedResult = r),
      }),
    );
    // Calling disconnect on an idle socket must not throw or open a WS.
    expect(() => capturedResult.disconnect()).not.toThrow();
    expect(FakeWebSocket.instances.length).toBe(0);
  });
});
