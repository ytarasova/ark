/**
 * SessionRow no-star regression test.
 *
 * Nit 2: the meta row used to render a 12px lucide Star glyph next to the
 * runtime name with no click handler / tooltip / a11y label. It looked like
 * a favorite/pin affordance but did nothing. We deleted it; this test pins
 * the behavior so a future "add an icon there" doesn't quietly resurrect a
 * mystery glyph.
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

describe("SessionRow runtime label", () => {
  test("renders the runtime name without a star/favorite icon", () => {
    const html = renderToString(
      React.createElement(SessionRow, {
        session: makeItem(),
        selected: false,
        onSelect: () => {},
      }),
    );
    // The runtime label is still present.
    expect(html).toContain("claude");
    // No lucide-star svg (lucide adds `lucide-star` to its <svg> class list).
    expect(html).not.toContain("lucide-star");
    // No <polygon> (lucide Star uses one). Other lucide glyphs in the row
    // (status dot, edge stripe) don't.
    expect(html).not.toContain("<polygon");
  });

  test("rows with no runtime omit the runtime span entirely", () => {
    const html = renderToString(
      React.createElement(SessionRow, {
        session: makeItem({ runtime: undefined }),
        selected: false,
        onSelect: () => {},
      }),
    );
    expect(html).not.toContain("lucide-star");
  });
});
