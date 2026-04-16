/**
 * Tests for useStatusMessage -- temporary status message with auto-clear.
 */

import { describe, it, expect } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { Text } from "ink";
import { useStatusMessage } from "../hooks/useStatusMessage.js";
import { waitFor } from "../../core/__tests__/test-helpers.js";

let statusRef: ReturnType<typeof useStatusMessage> | null = null;

function StatusInspector({ clearMs }: { clearMs?: number }) {
  const status = useStatusMessage(clearMs);
  statusRef = status;
  return <Text>{status.message ?? "empty"}</Text>;
}

describe("useStatusMessage", () => {
  it("starts with null message", () => {
    const { lastFrame, unmount } = render(<StatusInspector />);
    expect(lastFrame()!).toContain("empty");
    expect(statusRef!.message).toBeNull();
    unmount();
  });

  it("show() sets the message", async () => {
    const { lastFrame, unmount } = render(<StatusInspector clearMs={5000} />);
    statusRef!.show("Hello");
    await waitFor(() => statusRef!.message === "Hello");
    expect(statusRef!.message).toBe("Hello");
    expect(lastFrame()!).toContain("Hello");
    unmount();
  });

  it("clear() removes the message immediately", async () => {
    const { lastFrame, unmount } = render(<StatusInspector clearMs={5000} />);
    statusRef!.show("Visible");
    await waitFor(() => statusRef!.message === "Visible");
    expect(statusRef!.message).toBe("Visible");

    statusRef!.clear();
    await waitFor(() => statusRef!.message === null);
    expect(statusRef!.message).toBeNull();
    expect(lastFrame()!).toContain("empty");
    unmount();
  });

  it("auto-clears after timeout", async () => {
    const { lastFrame, unmount } = render(<StatusInspector clearMs={200} />);
    statusRef!.show("Temporary");
    await waitFor(() => statusRef!.message === "Temporary");
    expect(statusRef!.message).toBe("Temporary");

    // Wait for the auto-clear timer to fire (this is testing timer behavior)
    await waitFor(() => statusRef!.message === null, { timeout: 2000 });
    expect(statusRef!.message).toBeNull();
    expect(lastFrame()!).toContain("empty");
    unmount();
  });

  it("show() resets the timer on repeated calls", async () => {
    const { unmount } = render(<StatusInspector clearMs={200} />);

    statusRef!.show("First");
    await new Promise(r => setTimeout(r, 100));
    expect(statusRef!.message).toBe("First");

    // Reset the timer by showing a new message
    statusRef!.show("Second");
    await new Promise(r => setTimeout(r, 150));
    // 150ms after "Second" -- should still be visible (timer is 200ms)
    expect(statusRef!.message).toBe("Second");

    // Wait for the remaining time + buffer for the auto-clear
    await waitFor(() => statusRef!.message === null, { timeout: 2000 });
    expect(statusRef!.message).toBeNull();
    unmount();
  });
});
