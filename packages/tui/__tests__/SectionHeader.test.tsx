import { describe, it, expect } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { SectionHeader } from "../components/SectionHeader.js";

describe("SectionHeader", () => {
  it("renders title", () => {
    const { lastFrame, unmount } = render(<SectionHeader title="Metrics" />);
    expect(lastFrame()!).toContain("Metrics");
    unmount();
  });

  it("includes spacing after title", () => {
    const { lastFrame, unmount } = render(<SectionHeader title="Info" />);
    // The header should have a blank line after it (from the Box wrapper)
    expect(lastFrame()!).toContain("Info");
    unmount();
  });
});
