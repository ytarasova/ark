import { describe, it, expect } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { FormPathField } from "../components/form/index.js";

describe("FormPathField", () => {
  it("shows path value when not editing", () => {
    const { lastFrame, unmount } = render(
      <FormPathField label="Repo" value="/Users/test/project" onChange={() => {}} active={true} />
    );
    expect(lastFrame()!).toContain("/Users/test/project");
    expect(lastFrame()!).toContain("Repo");
    unmount();
  });

  it("shows > indicator when active", () => {
    const { lastFrame, unmount } = render(
      <FormPathField label="Repo" value="/tmp" onChange={() => {}} active={true} />
    );
    expect(lastFrame()!).toContain(">");
    unmount();
  });

  it("enters edit mode on Enter", async () => {
    const { lastFrame, stdin, unmount } = render(
      <FormPathField label="Repo" value="/tmp" onChange={() => {}} active={true} />
    );
    stdin.write("\r");
    await new Promise(r => setTimeout(r, 50));
    // In edit mode, shows * indicator
    expect(lastFrame()!).toContain("*");
    unmount();
  });

  it("shows dim when inactive", () => {
    const { lastFrame, unmount } = render(
      <FormPathField label="Repo" value="/tmp" onChange={() => {}} active={false} />
    );
    expect(lastFrame()!).not.toContain(">");
    expect(lastFrame()!).toContain("/tmp");
    unmount();
  });
});
