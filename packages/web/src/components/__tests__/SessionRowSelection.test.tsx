/**
 * SessionRow selection-ring tests.
 *
 * Verifies the selected row's border uses the `--primary` brand accent token
 * rather than a hardcoded purple, so the ring matches the `+ New` button +
 * brand tile gradient regardless of active theme.
 *
 * SSR-rendered (bun:test has no DOM) -- same pattern as SessionListTree.test.
 */

import { describe, test, expect } from "bun:test";
import React from "react";
import { renderToString } from "react-dom/server";
import { SessionRow, type SessionListItem } from "../ui/SessionList.js";

function makeItem(over: Partial<SessionListItem> = {}): SessionListItem {
  return {
    id: "s-1",
    status: "running",
    summary: "Demo session",
    runtime: "claude",
    relativeTime: "1m",
    ...over,
  };
}

function render(selected: boolean): string {
  return renderToString(
    React.createElement(SessionRow, {
      session: makeItem(),
      selected,
      onSelect: () => {},
    }),
  );
}

describe("SessionRow selection ring", () => {
  test("uses --primary token for the selected border (not a hardcoded purple rgba)", () => {
    const html = render(true);
    // The selected row exposes data-selected for assertion stability.
    expect(html).toContain('data-selected="true"');
    // Border class refers to the brand token, not the hardcoded purple.
    expect(html).toContain("border-[var(--primary)]");
    expect(html).not.toContain("rgba(107,89,222,0.5)");
    // aria-current is preserved for a11y.
    expect(html).toContain('aria-current="true"');
  });

  test("unselected row carries no selection border", () => {
    const html = render(false);
    expect(html).not.toContain('data-selected="true"');
    expect(html).not.toContain("border-[var(--primary)]");
  });
});
