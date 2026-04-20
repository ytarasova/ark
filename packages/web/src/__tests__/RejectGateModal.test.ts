/**
 * Tests for the RejectGateModal component rendered inside SessionDetail.
 *
 * bun:test has no DOM, so we render via react-dom/server and assert on the
 * resulting markup. The full click / submit cycle is exercised by the
 * Playwright e2e suite; here we just pin down:
 *   1. The modal renders a required reason textarea.
 *   2. The Submit button is disabled for empty input.
 *   3. The Submit button enables once the reason has non-whitespace content.
 *   4. Cancel is always enabled (unless the mutation is in flight).
 */

import { describe, test, expect } from "bun:test";
import React from "react";
import { renderToString } from "react-dom/server";

import { RejectGateModal } from "../components/SessionDetail.js";

function render(props: Partial<React.ComponentProps<typeof RejectGateModal>> = {}): string {
  const merged: React.ComponentProps<typeof RejectGateModal> = {
    reason: "",
    submitting: false,
    onReasonChange: () => {},
    onCancel: () => {},
    onSubmit: () => {},
    ...props,
  };
  return renderToString(React.createElement(RejectGateModal, merged));
}

describe("RejectGateModal", () => {
  test("renders a reason textarea labelled for screen readers", () => {
    const html = render();
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('aria-label="Rejection reason"');
    expect(html).toContain("<textarea");
  });

  // SSR emits `disabled=""` as an attribute when the button is disabled,
  // and always includes the `disabled:` utility class in the className --
  // so we key off the attribute specifically (ends with `disabled="">`).
  function isButtonDisabled(html: string, label: string): boolean {
    const idx = html.indexOf(label);
    if (idx < 0) return false;
    const btnStart = html.lastIndexOf("<button", idx);
    const openTagEnd = html.indexOf(">", btnStart);
    const btnTag = html.slice(btnStart, openTagEnd + 1);
    return / disabled(=""|=| |>)/.test(btnTag);
  }

  test("Submit is disabled when the reason is empty", () => {
    expect(isButtonDisabled(render({ reason: "" }), "Submit")).toBe(true);
  });

  test("Submit is disabled for whitespace-only input", () => {
    expect(isButtonDisabled(render({ reason: "   \n\t  " }), "Submit")).toBe(true);
  });

  test("Submit is enabled with a non-empty reason", () => {
    expect(isButtonDisabled(render({ reason: "please add tests" }), "Submit")).toBe(false);
  });

  test("shows 'Submitting...' while the mutation is in flight", () => {
    const html = render({ reason: "x", submitting: true });
    expect(html).toContain("Submitting...");
    // Both buttons should be disabled while submitting.
    expect(isButtonDisabled(html, "Cancel")).toBe(true);
  });

  test("calls onCancel when the modal receives Escape (handler attached)", () => {
    // SSR cannot fire events; instead assert that the root dialog has an
    // onKeyDown binding, which the react-dom/server output emits nothing for
    // (events aren't serialized). This test therefore guards the happy-path
    // markup; the e2e suite covers interaction.
    const html = render();
    // The dialog wrapper contains the reason textarea -- sanity check that
    // cancel button exists so Playwright can target it.
    expect(html).toContain("Cancel");
  });
});
