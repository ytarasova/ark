/**
 * Cost tab regression: must read tokens from BOTH the canonical
 * `input_tokens` / `output_tokens` shape (returned by `costs/session`
 * RPC) and the legacy `tokens_in` / `tokens_out` shape some older
 * call-sites still construct.
 *
 * Pre-fix the tab read only the legacy keys, so live agent-sdk
 * dispatches (which carry `input_tokens`/`output_tokens`) showed
 * `Tokens In: 0`, `Tokens Out: 0`, `Total Tokens: 0` next to a
 * non-zero `$0.16` cost -- the user-visible inconsistency in the
 * screenshot.
 */

import { describe, expect, test } from "bun:test";
import { renderToString } from "react-dom/server";
import { CostTab } from "../tabs/CostTab.js";

const session = { config: { model: "agent-sdk" }, agent: "inline" } as any;

describe("CostTab token field compatibility", () => {
  test("reads canonical input_tokens / output_tokens from costs/session", () => {
    const html = renderToString(
      <CostTab session={session} cost={{ cost: 0.163, input_tokens: 5, output_tokens: 506 }} />,
    );
    expect(html).toContain("$0.16"); // cost rendered
    expect(html).toContain("5"); // tokens_in
    expect(html).toContain("506"); // tokens_out
    expect(html).toContain("511"); // total = 5 + 506
  });

  test("falls back to legacy tokens_in / tokens_out shape", () => {
    const html = renderToString(<CostTab session={session} cost={{ cost: 0.05, tokens_in: 100, tokens_out: 200 }} />);
    expect(html).toContain("100");
    expect(html).toContain("200");
    expect(html).toContain("300");
  });

  test("renders 0 / -- when cost has no token fields", () => {
    const html = renderToString(<CostTab session={session} cost={{ cost: 0 }} />);
    // Total tokens is 0 -- effective-cost denominator is also 0, so '--'
    expect(html).toContain("--");
  });
});
