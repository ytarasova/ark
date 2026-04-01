import { describe, it, expect } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { FocusProvider } from "../hooks/useFocus.js";
import { withTestContext } from "../../core/__tests__/test-helpers.js";

describe("ToolsTab", () => {
  withTestContext();

  it("renders all category groups", async () => {
    const { ToolsTab } = await import("../tabs/ToolsTab.js");
    const { lastFrame } = render(
      <FocusProvider>
        <ToolsTab pane="left" />
      </FocusProvider>
    );
    const frame = lastFrame();
    expect(frame).toContain("MCP Servers");
    expect(frame).toContain("Commands");
    expect(frame).toContain("Skills");
    expect(frame).toContain("Recipes");
    expect(frame).toContain("Context");
  });

  it("renders Skills group (includes ark skills)", async () => {
    const { ToolsTab } = await import("../tabs/ToolsTab.js");
    const { lastFrame } = render(
      <FocusProvider>
        <ToolsTab pane="left" />
      </FocusProvider>
    );
    const frame = lastFrame();
    expect(frame).toContain("Skills");
  });

  it("renders Recipes group", async () => {
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
    // Should show details pane title
    expect(frame).toBeDefined();
    expect(frame).toContain("Details");
  });

  it("shows empty group placeholders for MCP Servers and Commands", async () => {
    const { ToolsTab } = await import("../tabs/ToolsTab.js");
    const { lastFrame } = render(
      <FocusProvider>
        <ToolsTab pane="left" />
      </FocusProvider>
    );
    const frame = lastFrame();
    // These groups should appear even when empty
    expect(frame).toContain("MCP Servers");
    expect(frame).toContain("Commands");
  });

  it("renders Tools as left panel title", async () => {
    const { ToolsTab } = await import("../tabs/ToolsTab.js");
    const { lastFrame } = render(
      <FocusProvider>
        <ToolsTab pane="left" />
      </FocusProvider>
    );
    const frame = lastFrame();
    expect(frame).toContain("Tools");
  });
});
