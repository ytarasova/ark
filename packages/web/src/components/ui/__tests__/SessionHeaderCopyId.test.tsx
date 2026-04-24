/**
 * SessionHeader copy-id placement test.
 *
 * Nit 3: the orphaned two-squares copy icon used to sit in the action-row
 * to the LEFT of the action group, with no label, so users couldn't tell
 * what it copied. We moved it INTO the breadcrumb row, immediately after
 * the session id, with a clear `aria-label="Copy session id"`.
 *
 * SSR-rendered so we can assert on raw markup.
 */

import { describe, test, expect } from "bun:test";
import React from "react";
import { renderToString } from "react-dom/server";
import { SessionHeader } from "../SessionHeader.js";

function render(opts: { onCopyId?: () => void; actions?: React.ReactNode } = {}): string {
  return renderToString(
    React.createElement(SessionHeader, {
      sessionId: "s-w8o8nln046",
      summary: "Demo session",
      status: "running",
      onCopyId: opts.onCopyId ?? (() => {}),
      actions: opts.actions,
    }),
  );
}

describe("SessionHeader copy-id button", () => {
  test("renders the copy button inside the breadcrumb row with an a11y label", () => {
    const html = render();
    expect(html).toContain('data-testid="breadcrumb-copy-id"');
    expect(html).toContain('aria-label="Copy session id"');
    // Tooltip text matches the aria-label so hover hint matches keyboard hint.
    expect(html).toContain('title="Copy session id"');
  });

  test("session id appears immediately before the copy button (one DOM hop)", () => {
    const html = render();
    const idIdx = html.indexOf("s-w8o8nln046");
    const btnIdx = html.indexOf('data-testid="breadcrumb-copy-id"');
    expect(idIdx).toBeGreaterThan(-1);
    expect(btnIdx).toBeGreaterThan(idIdx);
    // Sanity: nothing of substance between the id text and the button trigger.
    const between = html.slice(idIdx, btnIdx);
    expect(between.length).toBeLessThan(120);
  });

  test("the action-row no longer renders a duplicate 'copy id' icon button", () => {
    // The old IconButton used tip="copy id"; assert that's gone.
    const html = render({
      actions: React.createElement("div", { "data-testid": "real-actions" }, "actions"),
    });
    expect(html).not.toContain('aria-label="copy id"');
    expect(html).not.toContain('title="copy id"');
  });

  test("omitting onCopyId hides the breadcrumb copy button entirely", () => {
    const html = renderToString(
      React.createElement(SessionHeader, {
        sessionId: "s-w8o8nln046",
        summary: "Demo session",
        status: "running",
      }),
    );
    expect(html).not.toContain('data-testid="breadcrumb-copy-id"');
  });
});
