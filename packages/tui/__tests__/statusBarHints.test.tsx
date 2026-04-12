/**
 * Tests for statusBarHints — hint arrays for the TUI status bar.
 *
 * We inspect the React element tree directly instead of rendering to avoid
 * Ink test renderer width limitations that split words across lines.
 */

import { describe, it, expect } from "bun:test";
import React from "react";
import { getOverlayHints } from "../helpers/statusBarHints.js";
import {
  getSessionHints,
  resetSessionFilters,
  hasActiveSessionFilters,
  EMPTY_SESSION_FILTERS,
  statusGroupLabel,
} from "../tabs/SessionsTab.js";
import { getComputeHints } from "../tabs/ComputeTab.js";
import { getToolsHints } from "../tabs/ToolsTab.js";
import { getFlowsHints } from "../tabs/FlowsTab.js";
import type { Session } from "../../core/index.js";

/**
 * Extract {k, label} pairs from KeyHint elements in a hints array.
 * KeyHint renders <Text><Text bold>{k}</Text><Text>:{label}</Text></Text>
 * but we can read props from the React element tree.
 */
function extractHintLabels(hints: React.ReactNode[]): { k: string; label: string }[] {
  const result: { k: string; label: string }[] = [];
  for (const h of hints) {
    if (React.isValidElement(h)) {
      const props = h.props as Record<string, unknown>;
      if (props?.k && props?.label) {
        result.push({ k: props.k as string, label: props.label as string });
      }
    }
  }
  return result;
}

/** Check whether any hint in the array has the given label. */
function hasLabel(hints: React.ReactNode[], label: string): boolean {
  return extractHintLabels(hints).some(h => h.label === label);
}

/** Check whether any hint in the array has the given key. */
function hasKey(hints: React.ReactNode[], key: string): boolean {
  return extractHintLabels(hints).some(h => h.k === key);
}

describe("getOverlayHints", () => {
  it("form overlay returns Tab, Enter, Esc hints", () => {
    const hints = getOverlayHints("form");
    expect(hints).toHaveLength(3);
    const labels = extractHintLabels(hints);
    expect(labels).toEqual([
      { k: "Tab", label: "navigate" },
      { k: "Enter", label: "edit/select" },
      { k: "Esc", label: "cancel" },
    ]);
  });

  it("move overlay returns Enter and Esc hints", () => {
    const hints = getOverlayHints("move");
    expect(hints).toHaveLength(2);
    const labels = extractHintLabels(hints);
    expect(labels).toEqual([
      { k: "Enter", label: "confirm" },
      { k: "Esc", label: "cancel" },
    ]);
  });

  it("talk overlay returns Enter:send and Esc:close", () => {
    const hints = getOverlayHints("talk");
    expect(hints).toHaveLength(2);
    expect(hasLabel(hints, "send")).toBe(true);
    expect(hasLabel(hints, "close")).toBe(true);
  });

  it("inbox overlay returns Esc:close", () => {
    const hints = getOverlayHints("inbox");
    expect(hints).toHaveLength(1);
    expect(hasKey(hints, "Esc")).toBe(true);
    expect(hasLabel(hints, "close")).toBe(true);
  });

  it("unknown overlay returns Esc:cancel", () => {
    const hints = getOverlayHints("unknown");
    expect(hints).toHaveLength(1);
    expect(hasKey(hints, "Esc")).toBe(true);
    expect(hasLabel(hints, "cancel")).toBe(true);
  });
});

describe("getSessionHints", () => {
  it("null session returns only the group toggle hint", () => {
    const hints = getSessionHints(null);
    // No session selected = only the group-by-status toggle hint
    expect(hasLabel(hints, "group")).toBe(true);
    expect(hasLabel(hints, "attach")).toBe(false);
    expect(hasLabel(hints, "stop")).toBe(false);
  });

  it("running session includes attach, chat, stop, interrupt", () => {
    const session = { status: "running" } as Session;
    const hints = getSessionHints(session);
    expect(hasLabel(hints, "attach")).toBe(true);
    expect(hasLabel(hints, "chat")).toBe(true);
    expect(hasLabel(hints, "stop")).toBe(true);
    expect(hasLabel(hints, "interrupt")).toBe(true);
  });

  it("ready session includes dispatch", () => {
    const session = { status: "ready" } as Session;
    const hints = getSessionHints(session);
    expect(hasLabel(hints, "dispatch")).toBe(true);
  });

  it("stopped session includes restart", () => {
    const session = { status: "stopped" } as Session;
    const hints = getSessionHints(session);
    expect(hasLabel(hints, "restart")).toBe(true);
  });

  it("completed session includes restart", () => {
    const session = { status: "completed" } as Session;
    const hints = getSessionHints(session);
    expect(hasLabel(hints, "restart")).toBe(true);
  });

  it("waiting session includes attach and stop but not done", () => {
    const session = { status: "waiting" } as Session;
    const hints = getSessionHints(session);
    expect(hasLabel(hints, "attach")).toBe(true);
    expect(hasLabel(hints, "stop")).toBe(true);
    expect(hasLabel(hints, "done")).toBe(false);
  });

  it("all sessions with a selection include fork/clone, move, delete", () => {
    const session = { status: "running" } as Session;
    const hints = getSessionHints(session);
    expect(hasLabel(hints, "fork/clone")).toBe(true);
    expect(hasLabel(hints, "move")).toBe(true);
    expect(hasLabel(hints, "delete")).toBe(true);
  });

  it("no filter active: does NOT show 'clear filter' hint", () => {
    const hints = getSessionHints(null, EMPTY_SESSION_FILTERS);
    expect(hasLabel(hints, "clear filter")).toBe(false);
  });

  it("status filter active: shows Esc:clear filter hint even with no selection", () => {
    const hints = getSessionHints(null, { statusFilter: "running", groupByStatus: false });
    expect(hasLabel(hints, "clear filter")).toBe(true);
    expect(hasKey(hints, "Esc")).toBe(true);
  });

  it("status filter active with a selection: clear-filter hint comes before session actions", () => {
    const session = { status: "running" } as Session;
    const hints = getSessionHints(session, { statusFilter: "running", groupByStatus: false });
    const labels = extractHintLabels(hints).map(h => h.label);
    expect(labels[0]).toBe("clear filter");
    expect(hasLabel(hints, "attach")).toBe(true); // session-level hints still present
  });

  it("default filters arg is empty (back-compat with single-arg callers)", () => {
    const hints = getSessionHints(null);
    expect(hasLabel(hints, "clear filter")).toBe(false);
  });

  it("groupByStatus active: shows '%:ungroup' hint", () => {
    const hints = getSessionHints(null, { statusFilter: null, groupByStatus: true });
    expect(hasLabel(hints, "ungroup")).toBe(true);
    expect(hasKey(hints, "%")).toBe(true);
  });

  it("groupByStatus inactive: shows '%:group' hint", () => {
    const hints = getSessionHints(null, EMPTY_SESSION_FILTERS);
    expect(hasLabel(hints, "group")).toBe(true);
    expect(hasKey(hints, "%")).toBe(true);
  });
});

describe("session filter helpers", () => {
  it("EMPTY_SESSION_FILTERS has no active filter", () => {
    expect(hasActiveSessionFilters(EMPTY_SESSION_FILTERS)).toBe(false);
  });

  it("EMPTY_SESSION_FILTERS includes groupByStatus: false", () => {
    expect(EMPTY_SESSION_FILTERS.groupByStatus).toBe(false);
  });

  it("hasActiveSessionFilters returns true when statusFilter is set", () => {
    expect(hasActiveSessionFilters({ statusFilter: "running", groupByStatus: false })).toBe(true);
    expect(hasActiveSessionFilters({ statusFilter: "failed", groupByStatus: false })).toBe(true);
  });

  it("hasActiveSessionFilters returns false when statusFilter is null", () => {
    expect(hasActiveSessionFilters({ statusFilter: null, groupByStatus: false })).toBe(false);
  });

  it("hasActiveSessionFilters is not affected by groupByStatus alone", () => {
    expect(hasActiveSessionFilters({ statusFilter: null, groupByStatus: true })).toBe(false);
  });

  it("resetSessionFilters clears every dimension regardless of input", () => {
    expect(resetSessionFilters({ statusFilter: "running", groupByStatus: true })).toEqual(EMPTY_SESSION_FILTERS);
    expect(resetSessionFilters({ statusFilter: "failed", groupByStatus: false })).toEqual(EMPTY_SESSION_FILTERS);
    expect(resetSessionFilters({ statusFilter: null, groupByStatus: false })).toEqual(EMPTY_SESSION_FILTERS);
  });

  it("resetSessionFilters output is itself inactive (idempotent)", () => {
    const cleared = resetSessionFilters({ statusFilter: "running", groupByStatus: true });
    expect(hasActiveSessionFilters(cleared)).toBe(false);
    // running it again on already-cleared state is a no-op
    expect(resetSessionFilters(cleared)).toEqual(cleared);
  });
});

describe("statusGroupLabel", () => {
  it("maps known statuses to display labels", () => {
    expect(statusGroupLabel("running")).toBe("Running");
    expect(statusGroupLabel("waiting")).toBe("Waiting");
    expect(statusGroupLabel("blocked")).toBe("Blocked");
    expect(statusGroupLabel("ready")).toBe("Ready");
    expect(statusGroupLabel("pending")).toBe("Pending");
    expect(statusGroupLabel("completed")).toBe("Completed");
    expect(statusGroupLabel("stopped")).toBe("Stopped");
    expect(statusGroupLabel("failed")).toBe("Failed");
    expect(statusGroupLabel("archived")).toBe("Archived");
  });

  it("maps unknown statuses to 'Other'", () => {
    expect(statusGroupLabel("unknown")).toBe("Other");
    expect(statusGroupLabel("")).toBe("Other");
  });
});

describe("getComputeHints", () => {
  it("returns expected hint set", () => {
    const hints = getComputeHints();
    expect(hasKey(hints, "j/k")).toBe(true);
    expect(hasLabel(hints, "provision")).toBe(true);
    expect(hasLabel(hints, "start/stop")).toBe(true);
    expect(hasLabel(hints, "reboot")).toBe(true);
    expect(hasLabel(hints, "test")).toBe(true);
    expect(hasLabel(hints, "delete")).toBe(true);
    expect(hasLabel(hints, "clean")).toBe(true);
    expect(hasLabel(hints, "new")).toBe(true);
    expect(hasLabel(hints, "quit")).toBe(true);
  });
});

describe("getToolsHints", () => {
  it("includes nav, delete, and quit hints", () => {
    const hints = getToolsHints();
    expect(hasKey(hints, "j/k")).toBe(true);
    expect(hasLabel(hints, "delete")).toBe(true);
    expect(hasLabel(hints, "quit")).toBe(true);
  });
});

describe("getFlowsHints", () => {
  it("includes nav, Tab detail, and quit hints", () => {
    const hints = getFlowsHints();
    expect(hasKey(hints, "j/k")).toBe(true);
    expect(hasKey(hints, "Tab")).toBe(true);
    expect(hasLabel(hints, "detail")).toBe(true);
    expect(hasLabel(hints, "quit")).toBe(true);
  });
});
