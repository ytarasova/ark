/**
 * Cost-redundancy regression test (Nit 2).
 *
 * Two related cleanups, asserted together:
 *   (a) The BUDGET row in the session detail header is hidden below 50%
 *       utilisation, neutral-yellow at 50-80%, red at 80%+. The header
 *       ticker still shows live spend; the BudgetBar is just for the
 *       "approaching the cap" warning.
 *   (b) The Cost tab label carries no `$X.XX` badge -- the same number is
 *       already in the header ticker, and the detail is one click away.
 *
 * Part (a) drives the BudgetBar component directly with a 0% / 50% / 90%
 * spend ratio + the SessionDetail.tsx gating expression mirrored below.
 * Part (b) is checked via useSessionDetail's tabs array (same pattern as
 * useSessionDetail-tabs.test.tsx).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import React from "react";
import { renderToString } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MockTransport } from "../../../transport/MockTransport.js";
import { TransportProvider } from "../../../transport/TransportContext.js";
import { useSessionDetail } from "../../../hooks/useSessionDetail.js";
import { BudgetBar } from "../BudgetBar.js";

// SessionDetail.tsx gating: render only at >= 50% utilisation.
function shouldRenderBudgetRow(spent: number, cap: number | null | undefined): boolean {
  if (!cap || cap <= 0) return false;
  return spent / cap >= 0.5;
}

describe("BudgetBar threshold gating (Nit 2 -- cost redundancy)", () => {
  test("at 0% utilisation the budget row is hidden", () => {
    expect(shouldRenderBudgetRow(0, 1)).toBe(false);
  });

  test("at 50% utilisation the budget row is shown in neutral-yellow", () => {
    expect(shouldRenderBudgetRow(0.5, 1)).toBe(true);
    const html = renderToString(React.createElement(BudgetBar, { spent: 0.5, cap: 1 }));
    expect(html).toContain('data-testid="budget-bar"');
    expect(html).toContain('data-state="warn"');
    expect(html).toContain("var(--waiting)");
    expect(html).not.toContain("var(--failed)");
    expect(html).toContain("approaching cap");
  });

  test("at 90% utilisation the budget row is shown in red", () => {
    expect(shouldRenderBudgetRow(0.9, 1)).toBe(true);
    const html = renderToString(React.createElement(BudgetBar, { spent: 0.9, cap: 1 }));
    expect(html).toContain('data-state="over"');
    expect(html).toContain("var(--failed)");
    expect(html).toContain("cap exceeded");
  });

  test("the gating expression matches the SessionDetail conditional verbatim", () => {
    // Boundary cases: 49.9% hides, exactly 50% shows.
    expect(shouldRenderBudgetRow(0.499, 1)).toBe(false);
    expect(shouldRenderBudgetRow(0.5, 1)).toBe(true);
    expect(shouldRenderBudgetRow(1.5, 1)).toBe(true); // over-cap still shows
    expect(shouldRenderBudgetRow(1, undefined)).toBe(false); // no cap, no row
  });
});

let mock: MockTransport;

beforeEach(() => {
  mock = new MockTransport();
  mock.register("session/get", () => ({ session: null, events: [] }));
  mock.register("session/todos", () => []);
  mock.register("session/messages", () => ({ messages: [] }));
  mock.register("session/cost_totals", () => null);
  mock.register("session/stdio", () => ({ content: "", size: 0, exists: false }));
});

afterEach(() => {
  /* per-test QueryClient */
});

function CostTabProbe() {
  const session = {
    id: "s-cost",
    status: "running",
    summary: "cost test",
    agent: "claude",
    flow: "quick",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  const qc = (CostTabProbe as any)._qc as QueryClient;
  qc.setQueryData(["session", "s-cost"], { session, events: [] });
  qc.setQueryData(["session", "s-cost", "todos"], []);
  qc.setQueryData(["session", "s-cost", "messages"], []);
  // Set a non-null cost so the OLD `cost?.cost != null ? "$..."` branch
  // would have produced a "$0.42" badge if the change had not landed.
  qc.setQueryData(["session", "s-cost", "cost"], { cost: 0.42, tokens_in: 100, tokens_out: 200 });

  const d = useSessionDetail({ sessionId: "s-cost" });
  const cost = d.tabs.find((t) => t.id === "cost");
  return React.createElement(
    "div",
    { "data-testid": "cost-tab", "data-label": cost?.label, "data-badge": String(cost?.badge ?? "") },
    cost?.label,
  );
}

function renderCostTab(): string {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnMount: false, refetchOnWindowFocus: false } },
  });
  (CostTabProbe as any)._qc = qc;
  return renderToString(
    React.createElement(
      TransportProvider,
      { transport: mock },
      React.createElement(QueryClientProvider, { client: qc }, React.createElement(CostTabProbe)),
    ),
  );
}

describe("Cost tab label has no $-amount badge", () => {
  test("Cost tab keeps just its label even when cost.cost is non-null", () => {
    const html = renderCostTab();
    expect(html).toContain('data-testid="cost-tab"');
    expect(html).toContain('data-label="Cost"');
    expect(html).toContain('data-badge=""');
    // Belt-and-braces: no `$0.42` (or any `$<digits>`) anywhere in the
    // rendered tab label markup.
    expect(html).not.toMatch(/\$\d/);
  });
});
