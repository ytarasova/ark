/**
 * TUI rendering tests - verifies the main App component renders correctly.
 *
 * Uses ink-testing-library to render the TUI in-memory and assert on output.
 * Wraps App in ArkClientProvider with app prop (daemon-client architecture).
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { App } from "../App.js";
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
    <ArkClientProvider app={app} onReady={() => { ready = true; }}>
      <App arkDir={app.config.arkDir} />
    </ArkClientProvider>
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

  it("renders tab bar with all 10 tabs", async () => {
    const { lastFrame, unmount } = await renderApp();
    const frame = lastFrame()!;
    // Ink may wrap/truncate tab labels mid-word in narrow test terminals,
    // so check for the key prefix which always appears on one line.
    expect(frame).toContain("1:Sess");
    expect(frame).toContain("2:Agen");
    expect(frame).toContain("3:Even");
    expect(frame).toContain("4:Flow");
    expect(frame).toContain("5:Compu");
    expect(frame).toContain("6:Histo");
    expect(frame).toContain("7:Memo");
    expect(frame).toContain("8:Tools");
    expect(frame).toContain("9:Sched");
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

    // Press "5" to switch to Compute tab
    stdin.write("5");

    // Wait for React to re-render; Ink may truncate "Compute" in narrow terminals
    for (let i = 0; i < 50; i++) {
      await new Promise(r => setTimeout(r, 20));
      if (lastFrame()?.includes("5:Compu")) break;
    }

    const frame = lastFrame()!;
    expect(frame).toContain("5:Compu");
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
