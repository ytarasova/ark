import { describe, it, expect } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { FormTextArea } from "../components/form/index.js";
import { waitFor } from "../../core/__tests__/test-helpers.js";

describe("FormTextArea", () => {
  it("shows preview of value when not editing", () => {
    const { lastFrame, unmount } = render(
      <FormTextArea label="Prompt" value="You are a helpful assistant." onChange={() => {}} active={true} />
    );
    expect(lastFrame()!).toContain("You are a helpful");
    unmount();
  });

  it("shows placeholder when empty", () => {
    const { lastFrame, unmount } = render(
      <FormTextArea label="Prompt" value="" onChange={() => {}} active={true} placeholder="Enter prompt..." />
    );
    expect(lastFrame()!).toContain("Enter prompt...");
    unmount();
  });

  it("enters edit mode on Enter", async () => {
    const { lastFrame, stdin, unmount } = render(
      <FormTextArea label="Prompt" value="hello" onChange={() => {}} active={true} />
    );
    stdin.write("\r");
    // In edit mode, the FormField prefix changes from "> " to "* "
    await waitFor(() => lastFrame()!.includes("*"));
    expect(lastFrame()!).toContain("*");
    // The cursor block (inverse space) appears after the text in edit mode
    expect(lastFrame()!).toContain("hello");
    unmount();
  });

  it("truncates preview to previewLines", () => {
    const multiline = "line one\nline two\nline three\nline four";
    const { lastFrame, unmount } = render(
      <FormTextArea label="Notes" value={multiline} onChange={() => {}} active={false} previewLines={1} />
    );
    const frame = lastFrame()!;
    expect(frame).toContain("line one");
    expect(frame).toContain("...");
    unmount();
  });
});
