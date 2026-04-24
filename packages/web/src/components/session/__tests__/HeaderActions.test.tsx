/**
 * HeaderActions per-state visibility tests.
 *
 * Verifies the new primary + overflow split:
 *   - At most one primary action button is visible per state (or two for the
 *     blocked review-gate dual-choice).
 *   - Stop / Restart / Approve / Reject only render in their applicable
 *     states; Archive / Delete / Restore live exclusively in the overflow.
 *   - The overflow `...` trigger appears whenever the menu has items.
 *
 * SSR via react-dom/server -- mirrors the SessionListTree test setup. The
 * radix dropdown popover content is portaled and only mounts when opened,
 * so we assert on the trigger's data-testid rather than the menu items
 * themselves.
 */

import { describe, test, expect } from "bun:test";
import React from "react";
import { renderToString } from "react-dom/server";
import { HeaderActions } from "../HeaderActions.js";

interface RenderOpts {
  status: string;
  isActive?: boolean;
  canShowGate?: boolean;
  actionLoading?: string | null;
}

function render(opts: RenderOpts): string {
  return renderToString(
    React.createElement(HeaderActions, {
      status: opts.status,
      isActive: opts.isActive ?? false,
      canShowGate: opts.canShowGate ?? false,
      actionLoading: opts.actionLoading ?? null,
      onAction: () => {},
      onDelete: () => {},
      onApprove: () => {},
      onOpenReject: () => {},
      onOpenRestart: () => {},
    }),
  );
}

const PRIMARY_KEYS = ["approve", "reject", "stop", "restart"] as const;

function visiblePrimaries(html: string): string[] {
  return PRIMARY_KEYS.filter((k) => html.includes(`data-testid="header-actions-${k}"`));
}

describe("HeaderActions state matrix", () => {
  test("running -> primary Stop + overflow", () => {
    const html = render({ status: "running", isActive: true });
    expect(visiblePrimaries(html)).toEqual(["stop"]);
    expect(html).toContain('data-testid="header-actions-overflow"');
  });

  test("waiting -> primary Stop + overflow", () => {
    const html = render({ status: "waiting", isActive: true });
    expect(visiblePrimaries(html)).toEqual(["stop"]);
    expect(html).toContain('data-testid="header-actions-overflow"');
  });

  test("pending -> primary Stop + overflow", () => {
    const html = render({ status: "pending", isActive: true });
    expect(visiblePrimaries(html)).toEqual(["stop"]);
  });

  test("blocked (review gate) -> Approve + Reject pair, no Stop primary", () => {
    const html = render({ status: "blocked", canShowGate: true });
    expect(visiblePrimaries(html).sort()).toEqual(["approve", "reject"]);
    expect(html).toContain('data-testid="header-actions-overflow"');
  });

  test("completed -> primary Restart + overflow (Archive/Delete in menu)", () => {
    const html = render({ status: "completed" });
    expect(visiblePrimaries(html)).toEqual(["restart"]);
    expect(html).toContain('data-testid="header-actions-overflow"');
  });

  test("failed -> primary Restart + overflow", () => {
    const html = render({ status: "failed" });
    expect(visiblePrimaries(html)).toEqual(["restart"]);
  });

  test("stopped -> primary Restart + overflow", () => {
    const html = render({ status: "stopped" });
    expect(visiblePrimaries(html)).toEqual(["restart"]);
  });

  test("archived -> no primary, overflow only", () => {
    const html = render({ status: "archived" });
    expect(visiblePrimaries(html)).toEqual([]);
    expect(html).toContain('data-testid="header-actions-overflow"');
  });

  test("deleting -> spinner only, no buttons or overflow", () => {
    const html = render({ status: "deleting" });
    expect(visiblePrimaries(html)).toEqual([]);
    expect(html).not.toContain('data-testid="header-actions-overflow"');
    expect(html).toContain('data-testid="header-actions-deleting"');
  });

  test("Archive button never appears as a primary action", () => {
    for (const status of ["running", "completed", "failed", "stopped", "blocked", "archived", "pending"]) {
      const html = render({
        status,
        isActive: status === "running" || status === "pending",
        canShowGate: status === "blocked",
      });
      expect(html).not.toContain('aria-label="Archive session"');
    }
  });
});
