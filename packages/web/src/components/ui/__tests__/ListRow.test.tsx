/**
 * ListRow atom tests.
 *
 * bun:test runs jsdom-free, so we cannot rely on real DOM event dispatch.
 * Instead we invoke the ListRow function component directly and walk the
 * returned React element's props. That's enough to exercise the handler
 * wiring (Click / Enter / Space all route through `onSelect`) plus the
 * static accessibility contract (tabIndex, role, aria-pressed vs
 * aria-selected).
 */

import { describe, test, expect } from "bun:test";
import React from "react";
import { renderToString } from "react-dom/server";
import { ListRow } from "../ListRow.js";

// Invoke the function component and return the resulting React element so
// we can inspect its props (the element is the top-level <div>).
function renderElement(props: React.ComponentProps<typeof ListRow>) {
  return ListRow(props) as React.ReactElement<Record<string, any>>;
}

describe("ListRow", () => {
  test("clicking triggers onSelect", () => {
    let calls = 0;
    const el = renderElement({ onSelect: () => void calls++, children: "row" });
    // onClick is wired directly to onSelect.
    el.props.onClick?.({} as any);
    expect(calls).toBe(1);
  });

  test("pressing Enter triggers onSelect and calls preventDefault", () => {
    let calls = 0;
    let prevented = false;
    const el = renderElement({ onSelect: () => void calls++, children: "row" });
    const fakeEvent = {
      key: "Enter",
      preventDefault: () => {
        prevented = true;
      },
    };
    el.props.onKeyDown?.(fakeEvent);
    expect(calls).toBe(1);
    expect(prevented).toBe(true);
  });

  test("pressing Space triggers onSelect and calls preventDefault", () => {
    let calls = 0;
    let prevented = false;
    const el = renderElement({ onSelect: () => void calls++, children: "row" });
    const fakeEvent = {
      key: " ",
      preventDefault: () => {
        prevented = true;
      },
    };
    el.props.onKeyDown?.(fakeEvent);
    expect(calls).toBe(1);
    expect(prevented).toBe(true);
  });

  test("other keys do NOT trigger onSelect", () => {
    let calls = 0;
    const el = renderElement({ onSelect: () => void calls++, children: "row" });
    el.props.onKeyDown?.({ key: "ArrowDown", preventDefault: () => {} });
    el.props.onKeyDown?.({ key: "Tab", preventDefault: () => {} });
    expect(calls).toBe(0);
  });

  test("user-supplied onKeyDown still fires alongside Enter activation", () => {
    let userCalls = 0;
    let selectCalls = 0;
    const el = renderElement({
      onSelect: () => void selectCalls++,
      onKeyDown: () => void userCalls++,
      children: "row",
    });
    el.props.onKeyDown?.({ key: "Enter", preventDefault: () => {} });
    expect(selectCalls).toBe(1);
    expect(userCalls).toBe(1);
    // Non-activation keys still hit the user handler (it runs unconditionally).
    el.props.onKeyDown?.({ key: "ArrowDown", preventDefault: () => {} });
    expect(userCalls).toBe(2);
    expect(selectCalls).toBe(1);
  });

  test("tabIndex is 0", () => {
    const el = renderElement({ onSelect: () => {}, children: "row" });
    expect(el.props.tabIndex).toBe(0);
  });

  test("role defaults to 'button' and uses aria-pressed for selection", () => {
    const el = renderElement({ onSelect: () => {}, selected: true, children: "row" });
    expect(el.props.role).toBe("button");
    expect(el.props["aria-pressed"]).toBe(true);
    expect(el.props["aria-selected"]).toBeUndefined();
  });

  test("role='option' override uses aria-selected instead of aria-pressed", () => {
    const el = renderElement({ role: "option", onSelect: () => {}, selected: true, children: "row" });
    expect(el.props.role).toBe("option");
    expect(el.props["aria-selected"]).toBe(true);
    expect(el.props["aria-pressed"]).toBeUndefined();
  });

  test("forwards extra HTML attributes to the root div", () => {
    // SSR check: asserts role + tabIndex + data-* land in the real output.
    const html = renderToString(
      React.createElement(ListRow, { onSelect: () => {}, "data-testid": "my-row", children: "hi" } as any),
    );
    expect(html).toContain('role="button"');
    expect(html).toContain('tabindex="0"');
    expect(html).toContain('data-testid="my-row"');
    expect(html).toContain(">hi<");
  });

  test("SSR of role='option' emits aria-selected but not aria-pressed", () => {
    const html = renderToString(
      React.createElement(ListRow, { role: "option", selected: true, onSelect: () => {}, children: "x" }),
    );
    expect(html).toContain('role="option"');
    expect(html).toContain('aria-selected="true"');
    expect(html).not.toContain("aria-pressed");
  });
});
