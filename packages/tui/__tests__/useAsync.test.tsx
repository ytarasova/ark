/**
 * Tests for useAsync — queued action runner with onComplete.
 */

import { describe, it, expect } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { Text } from "ink";
import { useAsync } from "../hooks/useAsync.js";

function AsyncInspector({ onComplete }: { onComplete?: () => void }) {
  const async = useAsync(onComplete);
  return (
    <Text>
      {`loading=${async.loading} label=${async.label ?? "none"} error=${async.error ?? "none"}`}
    </Text>
  );
}

describe("useAsync", () => {
  it("starts with loading=false", () => {
    const { lastFrame, unmount } = render(<AsyncInspector />);
    expect(lastFrame()!).toContain("loading=false");
    unmount();
  });

  it("run() sets loading and label", async () => {
    let asyncRef: ReturnType<typeof useAsync> | null = null;
    function Capture() {
      asyncRef = useAsync();
      return <Text>{`loading=${asyncRef.loading}`}</Text>;
    }
    const { unmount } = render(<Capture />);
    asyncRef!.run("Test action", async () => {
      await new Promise(r => setTimeout(r, 100));
    });
    await new Promise(r => setTimeout(r, 50));
    // Should be loading
    expect(asyncRef!.loading).toBe(true);
    await new Promise(r => setTimeout(r, 200));
    unmount();
  });

  it("calls onComplete after successful action", async () => {
    let completed = 0;
    let asyncRef: ReturnType<typeof useAsync> | null = null;
    function Capture() {
      asyncRef = useAsync(() => { completed++; });
      return <Text>ok</Text>;
    }
    const { unmount } = render(<Capture />);

    asyncRef!.run("Action 1", () => {});
    await new Promise(r => setTimeout(r, 100));
    expect(completed).toBe(1);
    unmount();
  });

  it("queues multiple actions — executes in order", async () => {
    const order: string[] = [];
    let asyncRef: ReturnType<typeof useAsync> | null = null;
    function Capture() {
      asyncRef = useAsync();
      return <Text>ok</Text>;
    }
    const { unmount } = render(<Capture />);

    asyncRef!.run("First", async () => {
      await new Promise(r => setTimeout(r, 50));
      order.push("first");
    });
    asyncRef!.run("Second", async () => {
      await new Promise(r => setTimeout(r, 50));
      order.push("second");
    });
    asyncRef!.run("Third", () => { order.push("third"); });

    await new Promise(r => setTimeout(r, 300));
    expect(order).toEqual(["first", "second", "third"]);
    unmount();
  });

  it("calls onComplete after each queued action", async () => {
    let completed = 0;
    let asyncRef: ReturnType<typeof useAsync> | null = null;
    function Capture() {
      asyncRef = useAsync(() => { completed++; });
      return <Text>ok</Text>;
    }
    const { unmount } = render(<Capture />);

    asyncRef!.run("A", () => {});
    asyncRef!.run("B", () => {});
    asyncRef!.run("C", () => {});

    await new Promise(r => setTimeout(r, 200));
    expect(completed).toBe(3);
    unmount();
  });

  it("captures errors without stopping the queue", async () => {
    const order: string[] = [];
    let asyncRef: ReturnType<typeof useAsync> | null = null;
    function Capture() {
      asyncRef = useAsync();
      return <Text>{`error=${asyncRef.error ?? "none"}`}</Text>;
    }
    const { unmount } = render(<Capture />);

    asyncRef!.run("Good", () => { order.push("good"); });
    asyncRef!.run("Bad", () => { throw new Error("boom"); });
    asyncRef!.run("After", () => { order.push("after"); });

    await new Promise(r => setTimeout(r, 200));
    expect(order).toContain("good");
    expect(order).toContain("after");
    unmount();
  });

  it("sync actions work", async () => {
    let ran = false;
    let asyncRef: ReturnType<typeof useAsync> | null = null;
    function Capture() {
      asyncRef = useAsync();
      return <Text>ok</Text>;
    }
    const { unmount } = render(<Capture />);

    asyncRef!.run("Sync", () => { ran = true; });
    await new Promise(r => setTimeout(r, 100));
    expect(ran).toBe(true);
    unmount();
  });
});
