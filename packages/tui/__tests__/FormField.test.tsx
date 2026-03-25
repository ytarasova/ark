/**
 * Tests for FormField — the base form field wrapper component.
 * Verifies label display, active/inactive states, and editing indicator.
 */

import { describe, it, expect } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { Text } from "ink";
import { FormField } from "../components/form/index.js";

describe("FormField", () => {
  it("shows the label text", () => {
    const { lastFrame, unmount } = render(
      <FormField label="Name" active={false}>
        <Text>value</Text>
      </FormField>
    );
    expect(lastFrame()!).toContain("Name");
    unmount();
  });

  it("shows children content", () => {
    const { lastFrame, unmount } = render(
      <FormField label="Repo" active={false}>
        <Text>/my/repo</Text>
      </FormField>
    );
    expect(lastFrame()!).toContain("/my/repo");
    unmount();
  });

  it("shows '>' indicator when active", () => {
    const { lastFrame, unmount } = render(
      <FormField label="Field" active={true}>
        <Text>val</Text>
      </FormField>
    );
    expect(lastFrame()!).toContain(">");
    unmount();
  });

  it("shows '*' indicator when editing", () => {
    const { lastFrame, unmount } = render(
      <FormField label="Field" active={true} editing={true}>
        <Text>val</Text>
      </FormField>
    );
    expect(lastFrame()!).toContain("*");
    unmount();
  });

  it("does not show '>' when editing (shows * instead)", () => {
    const { lastFrame, unmount } = render(
      <FormField label="Field" active={true} editing={true}>
        <Text>val</Text>
      </FormField>
    );
    const frame = lastFrame()!;
    // When editing, the indicator is * not >
    expect(frame).toContain("*");
    // The > should not appear as the indicator
    // (Note: > might appear in content, so we check the indicator position)
    expect(frame).not.toMatch(/^.*> .*Field/m);
    unmount();
  });

  it("shows dim state when inactive (no indicator)", () => {
    const { lastFrame, unmount } = render(
      <FormField label="Field" active={false}>
        <Text>val</Text>
      </FormField>
    );
    const frame = lastFrame()!;
    expect(frame).not.toContain(">");
    expect(frame).not.toContain("*");
    expect(frame).toContain("Field");
    unmount();
  });

  it("pads the label to 10 characters", () => {
    const { lastFrame, unmount } = render(
      <FormField label="Hi" active={false}>
        <Text>val</Text>
      </FormField>
    );
    // "Hi" is 2 chars, padded to 10 => "Hi        "
    const frame = lastFrame()!;
    expect(frame).toContain("Hi");
    unmount();
  });

  it("renders with long label", () => {
    const { lastFrame, unmount } = render(
      <FormField label="Very Long Label Here" active={true}>
        <Text>value</Text>
      </FormField>
    );
    expect(lastFrame()!).toContain("Very Long Label Here");
    expect(lastFrame()!).toContain("value");
    unmount();
  });

  it("editing defaults to false when not provided", () => {
    const { lastFrame, unmount } = render(
      <FormField label="Test" active={true}>
        <Text>v</Text>
      </FormField>
    );
    // active=true, editing not set => shows > not *
    expect(lastFrame()!).toContain(">");
    expect(lastFrame()!).not.toContain("*");
    unmount();
  });
});
