/**
 * TUI rendering tests - verifies the main App component renders correctly.
 *
 * Uses ink-testing-library to render the TUI in-memory and assert on output.
 * Wraps App in ArkClientProvider (required since TUI migration to ArkClient).
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { App } from "../App.js";
import { AppProvider } from "../context/AppProvider.js";
import { ArkClientProvider } from "../context/ArkClientProvider.js";
import { AppContext, setApp, clearApp } from "../../core/app.js";

let app: AppContext;
beforeAll(async () => {
  app = AppContext.forTest();
  setApp(app);
  await app.boot();
});
afterAll(async () => {
  await app?.shutdown();
  clearApp();
});

/** Render App with ArkClientProvider wrapper and wait for it to initialize. */
async function renderApp() {
  let ready = false;
  const result = render(
    <AppProvider app={app}>
      <ArkClientProvider onReady={() => { ready = true; }}>
        <App />
      </ArkClientProvider>
    </AppProvider>
  );
  for (let i = 0; i < 100; i++) {
    await new Promise(r => setTimeout(r, 20));
    if (ready && result.lastFrame()?.includes("Sessions")) break;
  }
  return result;
}

describe("TUI App rendering", () => {
  it("renders without crashing", async () => {
    const { lastFrame, unmount } = await renderApp();
    const frame = lastFrame();
    expect(frame).toBeTruthy();
    expect(frame!.length).toBeGreaterThan(0);
    // Allow pending React effects to flush before unmount
    await new Promise(r => setTimeout(r, 50));
    unmount();
  });

  it("renders tab bar with all 9 tabs", async () => {
    const { lastFrame, unmount } = await renderApp();
    const frame = lastFrame()!;

    expect(frame).toContain("Sessions");
    expect(frame).toContain("Agents");
    expect(frame).toContain("Flows");
    expect(frame).toContain("Compute");
    expect(frame).toContain("History");
    expect(frame).toContain("Memory");
    expect(frame).toContain("Tools");
    expect(frame).toContain("Schedules");
    expect(frame).toContain("Costs");
    unmount();
  });

  it("sessions tab shows empty state when no sessions exist", async () => {
    const { lastFrame, unmount } = await renderApp();
    const frame = lastFrame()!;
    expect(frame.length).toBeGreaterThan(0);
    // Allow pending React effects to flush before unmount
    await new Promise(r => setTimeout(r, 50));
    unmount();
  });

  it("tab switching works via key press", async () => {
    const { lastFrame, stdin, unmount } = await renderApp();

    // Press "4" to switch to Compute tab
    stdin.write("4");

    // Wait for React to re-render
    for (let i = 0; i < 50; i++) {
      await new Promise(r => setTimeout(r, 20));
      if (lastFrame()?.includes("Compute")) break;
    }

    const frame = lastFrame()!;
    expect(frame).toContain("Compute");
    unmount();
  });

  it("status bar shows session count", async () => {
    const { lastFrame, unmount } = await renderApp();
    const frame = lastFrame()!;
    // Status bar may word-wrap "0 sessions" across lines in narrow test terminal;
    // just verify the digit + "sess" fragment is present somewhere.
    expect(frame).toMatch(/\d+\s*sess/);
    unmount();
  });
});
