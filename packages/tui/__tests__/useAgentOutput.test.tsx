/**
 * Tests for useAgentOutput — poll agent output for a running session.
 * Uses a mock ArkClient instead of direct core imports.
 */

import { describe, it, expect } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { Text } from "ink";
import { useAgentOutput } from "../hooks/useAgentOutput.js";
import { createMockArkClient, MockArkClientProvider } from "./test-helpers.js";
import { waitFor } from "../../core/__tests__/test-helpers.js";

function OutputCapture({ sessionId, tmuxName, isRunning, pollMs }: {
  sessionId: string | null;
  tmuxName: string | null;
  isRunning: boolean;
  pollMs?: number;
}) {
  const output = useAgentOutput(sessionId, tmuxName, isRunning, pollMs);
  return <Text>{output || "no-output"}</Text>;
}

/** Wrap component in a mock ArkClient context. */
function WrappedOutputCapture(props: {
  sessionId: string | null;
  tmuxName: string | null;
  isRunning: boolean;
  pollMs?: number;
}) {
  const client = createMockArkClient({
    sessionOutput: async () => "",
  });
  return (
    <MockArkClientProvider client={client}>
      <OutputCapture {...props} />
    </MockArkClientProvider>
  );
}

describe("useAgentOutput", () => {
  it("returns empty string when sessionId is null", async () => {
    const { lastFrame, unmount } = render(
      <WrappedOutputCapture sessionId={null} tmuxName="some-tmux" isRunning={true} />
    );
    await waitFor(() => lastFrame()!.includes("no-output"));
    expect(lastFrame()!).toContain("no-output");
    unmount();
  });

  it("returns empty string when tmuxName is null", async () => {
    const { lastFrame, unmount } = render(
      <WrappedOutputCapture sessionId="sess-1" tmuxName={null} isRunning={true} />
    );
    await waitFor(() => lastFrame()!.includes("no-output"));
    expect(lastFrame()!).toContain("no-output");
    unmount();
  });

  it("returns empty string when not running", async () => {
    const { lastFrame, unmount } = render(
      <WrappedOutputCapture sessionId="sess-1" tmuxName="some-tmux" isRunning={false} />
    );
    await waitFor(() => lastFrame()!.includes("no-output"));
    expect(lastFrame()!).toContain("no-output");
    unmount();
  });

  it("returns empty for non-existent tmux session", async () => {
    const { lastFrame, unmount } = render(
      <WrappedOutputCapture
        sessionId="sess-1"
        tmuxName="ark-nonexistent-test-session-xyz"
        isRunning={true}
        pollMs={60000}
      />
    );
    // Mock returns empty string, so we should see no-output
    await waitFor(() => lastFrame()!.includes("no-output"), { timeout: 5000 });
    expect(lastFrame()!).toContain("no-output");
    unmount();
  });
});
