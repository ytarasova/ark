/**
 * Tests for statusBarHints — hint arrays for the TUI status bar.
 *
 * We inspect the React element tree directly instead of rendering to avoid
 * Ink test renderer width limitations that split words across lines.
 */

import { describe, it, expect } from "bun:test";
import React from "react";
import {
  getOverlayHints,
  getSessionHints,
  getComputeHints,
  getToolsHints,
  getFlowsHints,
} from "../helpers/statusBarHints.js";
import type { Session } from "../../core/index.js";

/**
 * Extract {k, label} pairs from KeyHint elements in a hints array.
 * KeyHint renders <Text><Text bold>{k}</Text><Text>:{label}</Text></Text>
 * but we can read props from the React element tree.
 */
function extractHintLabels(hints: React.ReactNode[]): { k: string; label: string }[] {
  const result: { k: string; label: string }[] = [];
  for (const h of hints) {
    if (React.isValidElement(h) && (h as any).props?.k && (h as any).props?.label) {
      result.push({ k: (h as any).props.k, label: (h as any).props.label });
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
  it("null session returns nav hints + new + groups + quit", () => {
    const hints = getSessionHints(null);
    expect(hasKey(hints, "j/k")).toBe(true);
    expect(hasLabel(hints, "move")).toBe(true);
    expect(hasLabel(hints, "new")).toBe(true);
    expect(hasLabel(hints, "groups")).toBe(true);
    expect(hasLabel(hints, "quit")).toBe(true);
    // Should NOT contain session-specific actions
    expect(hasLabel(hints, "attach")).toBe(false);
    expect(hasLabel(hints, "stop")).toBe(false);
  });

  it("running session includes attach, chat, stop, done", () => {
    const session = { status: "running" } as Session;
    const hints = getSessionHints(session);
    expect(hasLabel(hints, "attach")).toBe(true);
    expect(hasLabel(hints, "chat/threads")).toBe(true);
    expect(hasLabel(hints, "stop")).toBe(true);
    expect(hasLabel(hints, "done")).toBe(true);
    expect(hasLabel(hints, "quit")).toBe(true);
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
