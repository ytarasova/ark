/**
 * Tests for useConfirmation -- two-press confirmation pattern with auto-clear.
 */

import { describe, it, expect } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { Text } from "ink";
import { useConfirmation } from "../hooks/useConfirmation.js";
import { waitFor } from "../../core/__tests__/test-helpers.js";

let hookRef: ReturnType<typeof useConfirmation> | null = null;

function ConfirmInspector({ timeout }: { timeout?: number }) {
  const hook = useConfirmation({ timeout });
  hookRef = hook;
  return <Text>{hook.pending ?? "idle"}</Text>;
}

describe("useConfirmation", () => {
  it("first call returns false (pending)", () => {
    const { lastFrame, unmount } = render(<ConfirmInspector />);
    const result = hookRef!.confirm("delete", "Press x again");
    expect(result).toBe(false);
    unmount();
  });

  it("same action second call returns true (confirmed)", async () => {
    const { unmount } = render(<ConfirmInspector />);
    const first = hookRef!.confirm("delete", "Press x again");
    expect(first).toBe(false);

    // Wait for state to settle
    await waitFor(() => hookRef!.pending === "delete");

    const second = hookRef!.confirm("delete", "Press x again");
    expect(second).toBe(true);

    // Pending should be cleared after confirmation
    await waitFor(() => hookRef!.pending === null);
    expect(hookRef!.pending).toBeNull();
    unmount();
  });

  it("different action resets pending", async () => {
    const { unmount } = render(<ConfirmInspector />);
    hookRef!.confirm("delete", "Press x again");
    await waitFor(() => hookRef!.pending === "delete");
    expect(hookRef!.pending).toBe("delete");

    // Different action replaces the pending one
    const result = hookRef!.confirm("stop", "Press s again");
    expect(result).toBe(false);
    await waitFor(() => hookRef!.pending === "stop");
    expect(hookRef!.pending).toBe("stop");
    unmount();
  });

  it("cancel clears pending", async () => {
    const { unmount } = render(<ConfirmInspector />);
    hookRef!.confirm("delete", "Press x again");
    await waitFor(() => hookRef!.pending === "delete");
    expect(hookRef!.pending).toBe("delete");

    hookRef!.cancel();
    await waitFor(() => hookRef!.pending === null);
    expect(hookRef!.pending).toBeNull();
    unmount();
  });

  it("auto-clears after timeout", async () => {
    const { unmount } = render(<ConfirmInspector timeout={200} />);
    hookRef!.confirm("delete", "Press x again");
    await waitFor(() => hookRef!.pending === "delete");
    expect(hookRef!.pending).toBe("delete");

    // Wait for auto-clear
    await waitFor(() => hookRef!.pending === null, { timeout: 2000 });
    expect(hookRef!.pending).toBeNull();
    unmount();
  });
});
