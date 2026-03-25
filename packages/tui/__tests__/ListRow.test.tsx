import { describe, it, expect } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { ListRow } from "../components/ListRow.js";

describe("ListRow", () => {
  it("renders plain text when not selected", () => {
    const { lastFrame, unmount } = render(<ListRow selected={false}>  item</ListRow>);
    expect(lastFrame()!).toContain("item");
    unmount();
  });

  it("renders with padding when selected", () => {
    const { lastFrame, unmount } = render(<ListRow selected={true}>  selected</ListRow>);
    expect(lastFrame()!).toContain("selected");
    unmount();
  });
});
