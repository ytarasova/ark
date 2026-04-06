import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { FocusProvider } from "../hooks/useFocus.js";
import { ArkClientProvider } from "../context/ArkClientProvider.js";
import { AppContext, setApp, clearApp } from "../../core/app.js";

let app: AppContext;
beforeAll(async () => {
  app = AppContext.forTest();
  await app.boot();
  setApp(app);
});
afterAll(async () => {
  await app?.shutdown();
  clearApp();
});

/** Wait for ArkClientProvider to initialize and render children. */
async function renderWithClient(element: React.ReactElement) {
  let ready = false;
  const onReady = () => { ready = true; };

  const result = render(
    <ArkClientProvider onReady={onReady}>
      <FocusProvider>
        {element}
      </FocusProvider>
    </ArkClientProvider>
  );

  // Wait for the in-memory RPC round-trip and data fetch to complete
  for (let i = 0; i < 100; i++) {
    await new Promise(r => setTimeout(r, 20));
    if (ready && result.lastFrame()?.includes("Tools")) break;
  }

  return result;
}

describe("ToolsTab", () => {
  it("renders all category groups", async () => {
    const { ToolsTab } = await import("../tabs/ToolsTab.js");
    const { lastFrame } = await renderWithClient(<ToolsTab pane="left" />);
    const frame = lastFrame();
    expect(frame).toContain("MCP Servers");
    expect(frame).toContain("Commands");
    expect(frame).toContain("Skills");
    expect(frame).toContain("Recipes");
    expect(frame).toContain("Context");
  });

  it("renders Skills group (includes ark skills)", async () => {
    const { ToolsTab } = await import("../tabs/ToolsTab.js");
    const { lastFrame } = await renderWithClient(<ToolsTab pane="left" />);
    const frame = lastFrame();
    expect(frame).toContain("Skills");
  });

  it("renders Recipes group", async () => {
    const { ToolsTab } = await import("../tabs/ToolsTab.js");
    const { lastFrame } = await renderWithClient(<ToolsTab pane="left" />);
    const frame = lastFrame();
    expect(frame).toContain("Recipes");
  });

  it("shows detail pane when right is focused", async () => {
    const { ToolsTab } = await import("../tabs/ToolsTab.js");
    const { lastFrame } = await renderWithClient(<ToolsTab pane="right" />);
    const frame = lastFrame();
    expect(frame).toBeDefined();
    expect(frame).toContain("Details");
  });

  it("shows empty group placeholders for MCP Servers and Commands", async () => {
    const { ToolsTab } = await import("../tabs/ToolsTab.js");
    const { lastFrame } = await renderWithClient(<ToolsTab pane="left" />);
    const frame = lastFrame();
    expect(frame).toContain("MCP Servers");
    expect(frame).toContain("Commands");
  });

  it("renders Tools as left panel title", async () => {
    const { ToolsTab } = await import("../tabs/ToolsTab.js");
    const { lastFrame } = await renderWithClient(<ToolsTab pane="left" />);
    const frame = lastFrame();
    expect(frame).toContain("Tools");
  });
});
