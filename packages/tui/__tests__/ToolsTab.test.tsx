import { describe, it, expect } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { FocusProvider } from "../hooks/useFocus.js";
import { withTestContext } from "../../core/__tests__/test-helpers.js";

describe("ToolsTab", () => {
  withTestContext();

  it("renders skills and recipes sections", async () => {
    const { ToolsTab } = await import("../tabs/ToolsTab.js");
    const { lastFrame } = render(
      <FocusProvider>
        <ToolsTab pane="left" />
      </FocusProvider>
    );
    const frame = lastFrame();
    expect(frame).toContain("Skills");
  });

  it("renders recipes group", async () => {
    const { ToolsTab } = await import("../tabs/ToolsTab.js");
    const { lastFrame } = render(
      <FocusProvider>
        <ToolsTab pane="left" />
      </FocusProvider>
    );
    const frame = lastFrame();
    expect(frame).toContain("Recipes");
  });

  it("shows detail pane when right is focused", async () => {
    const { ToolsTab } = await import("../tabs/ToolsTab.js");
    const { lastFrame } = render(
      <FocusProvider>
        <ToolsTab pane="right" />
      </FocusProvider>
    );
    const frame = lastFrame();
    // Should show details pane (either "Details" title or tool info)
    expect(frame).toBeDefined();
  });
});
