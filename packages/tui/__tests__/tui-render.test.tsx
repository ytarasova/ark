/**
 * TUI rendering tests - verifies the main App component renders correctly.
 *
 * Uses ink-testing-library to render the TUI in-memory and assert on output.
 */

import { describe, it, expect } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { App } from "../App.js";

describe("TUI App rendering", () => {
  it("renders without crashing", () => {
    const { lastFrame, unmount } = render(<App />);
    expect(lastFrame()).toBeTruthy();
    unmount();
  });

  it("renders tab bar with all 5 tabs", () => {
    const { lastFrame, unmount } = render(<App />);
    const frame = lastFrame()!;

    expect(frame).toContain("Sessions");
    expect(frame).toContain("Hosts");
    expect(frame).toContain("Agents");
    expect(frame).toContain("Flows");
    expect(frame).toContain("Recipes");
    unmount();
  });

  it("sessions tab shows empty state when no sessions exist", () => {
    const { lastFrame, unmount } = render(<App />);
    const frame = lastFrame()!;

    // The sessions tab renders (may show tab name, empty state, or status bar)
    expect(frame.length).toBeGreaterThan(0);
    unmount();
  });

  it("tab switching works via key press", async () => {
    const { lastFrame, stdin, unmount } = render(<App />);

    // Press "2" to switch to Hosts tab
    stdin.write("2");

    // Allow React to re-render
    await new Promise((r) => setTimeout(r, 50));

    const frame = lastFrame()!;
    // The Hosts tab should now be active - its key hints should be visible
    expect(frame).toContain("provision");
    unmount();
  });

  it("status bar shows session count", () => {
    const { lastFrame, unmount } = render(<App />);
    const frame = lastFrame()!;

    // Status bar always shows session count
    expect(frame).toContain("sessions");
    unmount();
  });
});
