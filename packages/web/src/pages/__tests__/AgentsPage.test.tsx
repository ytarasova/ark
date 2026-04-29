/**
 * AgentsPage / AgentForm SSR tests.
 *
 * Targets the model selector regression from the schema rewrite: the form
 * used to read `runtime.models` / `runtime.default_model`, both of which
 * were deleted off RuntimeDefinition. The selector now sources options from
 * the `model/list` RPC (file-backed model catalog).
 *
 * We render AgentForm directly -- AgentsPage itself is a Layout wrapper and
 * asserting on the full page requires a live sessions / runtimes hookup.
 * This is the same pattern other web tests use (see IntegrationsPage test
 * for the harness shape).
 *
 * Note: the selector is a Radix Popover under the hood. SSR renders only
 * the trigger (selected option + label), not the popover items. Tests
 * therefore assert on the trigger's rendered label, plus on invariants
 * about what the trigger does NOT render anymore (the old datalist escape
 * hatch).
 */

import { beforeEach, describe, expect, test } from "bun:test";
import React from "react";
import { renderToString } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ModelDefinition } from "../../../../types/model.js";
import { MockTransport } from "../../transport/MockTransport.js";
import { TransportProvider } from "../../transport/TransportContext.js";
import { AgentForm } from "../../components/agents/AgentForm.js";

const MODELS: ModelDefinition[] = [
  {
    id: "claude-sonnet-4-6",
    display: "Claude Sonnet 4.6",
    provider: "anthropic",
    aliases: ["sonnet"],
    provider_slugs: { "anthropic-direct": "claude-sonnet-4-6" },
  },
  {
    id: "claude-opus-4-7",
    display: "Claude Opus 4.7",
    provider: "anthropic",
    aliases: ["opus"],
    provider_slugs: { "anthropic-direct": "claude-opus-4-7" },
  },
  {
    id: "gpt-5",
    display: "GPT-5",
    provider: "openai",
    provider_slugs: { "openai-direct": "gpt-5" },
  },
];

let mock: MockTransport;

function freshClient(): QueryClient {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // Pre-seed the hook so SSR sees the catalog without waiting on the mock.
  qc.setQueryData(["models"], MODELS);
  return qc;
}

beforeEach(() => {
  mock = new MockTransport();
  mock.register("model/list", () => ({ models: MODELS }));
});

function renderForm(agent?: Record<string, unknown>): string {
  const qc = freshClient();
  return renderToString(
    React.createElement(
      TransportProvider,
      { transport: mock },
      React.createElement(
        QueryClientProvider,
        { client: qc },
        React.createElement(AgentForm, {
          onClose: () => {},
          onSubmit: () => {},
          agent: agent ?? undefined,
          isEdit: !!agent,
          runtimes: [],
        }),
      ),
    ),
  );
}

describe("AgentForm model selector sources from the catalog", () => {
  test("selected catalog entry renders with '{display} -- {id}' as the trigger label", () => {
    const html = renderForm({ name: "worker", model: "claude-sonnet-4-6" });
    expect(html).toContain("Claude Sonnet 4.6 -- claude-sonnet-4-6");
    // Provider of the current selection appears in the trigger's description slot.
    expect(html).toContain("anthropic");
  });

  test("the selection honors the agent's current model id (not the default)", () => {
    const html = renderForm({ name: "worker", model: "claude-opus-4-7" });
    expect(html).toContain("Claude Opus 4.7 -- claude-opus-4-7");
    // The other catalog entry is NOT rendered in the closed popover.
    expect(html).not.toContain("GPT-5 -- gpt-5");
  });

  test("an agent model not in the catalog surfaces as '<unknown: {id}>'", () => {
    const html = renderForm({ name: "worker", model: "some-retired-model" });
    expect(html).toContain("&lt;unknown: some-retired-model&gt;");
  });

  test("the old `runtime.models` escape hatch (datalist) is gone", () => {
    const html = renderForm({ name: "worker", model: "claude-sonnet-4-6" });
    expect(html).not.toContain('id="model-suggestions"');
    expect(html).not.toContain('list="model-suggestions"');
  });
});
