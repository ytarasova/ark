import { describe, it, expect } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { Text } from "ink";
import { KeyValue } from "../components/KeyValue.js";

describe("KeyValue", () => {
  it("renders label and value", () => {
    const { lastFrame, unmount } = render(<KeyValue label="Name">test-host</KeyValue>);
    expect(lastFrame()!).toContain("Name");
    expect(lastFrame()!).toContain("test-host");
    unmount();
  });

  it("supports React node children", () => {
    const { lastFrame, unmount } = render(
      <KeyValue label="Status"><Text color="green">running</Text></KeyValue>
    );
    expect(lastFrame()!).toContain("running");
    unmount();
  });

  it("accepts custom width", () => {
    const { lastFrame, unmount } = render(<KeyValue label="ID" width={20}>abc</KeyValue>);
    expect(lastFrame()!).toContain("ID");
    expect(lastFrame()!).toContain("abc");
    unmount();
  });
});
