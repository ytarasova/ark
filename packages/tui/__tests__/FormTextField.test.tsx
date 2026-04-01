import { describe, it, expect } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { FormTextField } from "../components/form/index.js";
import { waitFor } from "../../core/__tests__/test-helpers.js";

describe("FormTextField", () => {
  it("shows value when not editing", () => {
    const { lastFrame, unmount } = render(
      <FormTextField label="Name" value="hello" onChange={() => {}} active={true} />
    );
    expect(lastFrame()!).toContain("hello");
    expect(lastFrame()!).toContain("Name");
    unmount();
  });

  it("shows placeholder when value is empty", () => {
    const { lastFrame, unmount } = render(
      <FormTextField label="Name" value="" onChange={() => {}} active={true} placeholder="type here" />
    );
    expect(lastFrame()!).toContain("type here");
    unmount();
  });

  it("shows > indicator when active", () => {
    const { lastFrame, unmount } = render(
      <FormTextField label="Name" value="test" onChange={() => {}} active={true} />
    );
    expect(lastFrame()!).toContain(">");
    unmount();
  });

  it("shows dim label when inactive", () => {
    const { lastFrame, unmount } = render(
      <FormTextField label="Name" value="test" onChange={() => {}} active={false} />
    );
    // No > indicator
    expect(lastFrame()!).not.toContain(">");
    expect(lastFrame()!).toContain("Name");
    unmount();
  });

  it("enters edit mode on Enter", async () => {
    const { lastFrame, stdin, unmount } = render(
      <FormTextField label="Name" value="test" onChange={() => {}} active={true} />
    );
    stdin.write("\r");
    await waitFor(() => lastFrame()!.includes("*"), { timeout: 2000, message: "Expected * indicator for edit mode" });
    expect(lastFrame()!).toContain("*");
    unmount();
  });
});
