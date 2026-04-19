/**
 * Tests for the ErrorBoundary wrapper.
 *
 * bun:test has no DOM, so we render via react-dom/server. This gives us
 * enough to verify:
 *   1. Happy path: children render when nothing throws.
 *   2. Static method: getDerivedStateFromError flips the state to the
 *      thrown error, so the fallback path takes over on the next render.
 *
 * The full mount+catch cycle is exercised by the Playwright e2e spec;
 * here we just pin down the non-DOM-dependent behaviour.
 */

import { describe, test, expect } from "bun:test";
import React from "react";
import { renderToString } from "react-dom/server";
import { ErrorBoundary } from "../components/ui/ErrorBoundary.js";

describe("ErrorBoundary", () => {
  test("renders children when no error is thrown", () => {
    const html = renderToString(
      React.createElement(ErrorBoundary, {}, React.createElement("span", { "data-testid": "kid" }, "hello")),
    );
    expect(html).toContain("hello");
    expect(html).toContain('data-testid="kid"');
  });

  test("getDerivedStateFromError stores the error in state", () => {
    const err = new Error("boom");
    const derived = (ErrorBoundary as any).getDerivedStateFromError(err);
    expect(derived).toEqual({ error: err });
  });
});
