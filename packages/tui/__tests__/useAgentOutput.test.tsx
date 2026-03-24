/**
 * Tests for useAgentOutput — poll tmux pane output for a running session.
 */

import { describe, it, expect } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { Text } from "ink";
import { useAgentOutput } from "../hooks/useAgentOutput.js";

function OutputCapture({ sessionId, tmuxName, isRunning, pollMs }: {
  sessionId: string | null;
  tmuxName: string | null;
  isRunning: boolean;
  pollMs?: number;
}) {
  const output = useAgentOutput(sessionId, tmuxName, isRunning, pollMs);
  return <Text>{output || "no-output"}</Text>;
}

describe("useAgentOutput", () => {
  it("returns empty string when sessionId is null", async () => {
    const { lastFrame, unmount } = render(
      <OutputCapture sessionId={null} tmuxName="some-tmux" isRunning={true} />
    );
    await new Promise(r => setTimeout(r, 100));
    expect(lastFrame()!).toContain("no-output");
    unmount();
  });

  it("returns empty string when tmuxName is null", async () => {
    const { lastFrame, unmount } = render(
      <OutputCapture sessionId="sess-1" tmuxName={null} isRunning={true} />
    );
    await new Promise(r => setTimeout(r, 100));
    expect(lastFrame()!).toContain("no-output");
    unmount();
  });

  it("returns empty string when not running", async () => {
    const { lastFrame, unmount } = render(
      <OutputCapture sessionId="sess-1" tmuxName="some-tmux" isRunning={false} />
    );
    await new Promise(r => setTimeout(r, 100));
    expect(lastFrame()!).toContain("no-output");
    unmount();
  });

  it("returns empty for non-existent tmux session", async () => {
    const { lastFrame, unmount } = render(
      <OutputCapture
        sessionId="sess-1"
        tmuxName="ark-nonexistent-test-session-xyz"
        isRunning={true}
        pollMs={60000}
      />
    );
    // Wait for the initial poll to complete (capturePaneAsync returns "" for missing sessions)
    await new Promise(r => setTimeout(r, 300));
    expect(lastFrame()!).toContain("no-output");
    unmount();
  });
});
