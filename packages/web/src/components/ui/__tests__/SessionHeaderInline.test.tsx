/**
 * SessionHeader inline-dispatch rendering test (Nit 1).
 *
 * When a session was dispatched with an inline flow + inline agent, the
 * meta strip used to show the literal `inline` (agent) and the synthetic
 * `inline-s-<id>` (flow) -- both Ark internals. SessionHeader now resolves
 * the actual `(runtime, model)` binding from `session.config.inline_flow`
 * and renders the model's display name when the catalog is available.
 *
 * Pattern matches the sibling SessionHeaderCopyId test: SSR-only, since
 * bun:test runs Node-without-DOM, and we're asserting on raw markup.
 */

import { describe, test, expect } from "bun:test";
import React from "react";
import { renderToString } from "react-dom/server";
import { SessionHeader } from "../SessionHeader.js";

const SAMPLE_MODELS = [
  {
    id: "claude-sonnet-4-6",
    display: "Claude Sonnet 4.6",
    aliases: ["sonnet", "sonnet-4.6"],
  },
  {
    id: "claude-opus-4-7",
    display: "Claude Opus 4.7",
  },
];

function renderInlineSession(opts: {
  agent?: string;
  flow?: string;
  stage?: string;
  inlineFlowName?: string;
  stageAgent?: { runtime: string; model: string };
  models?: typeof SAMPLE_MODELS;
}): string {
  const session = {
    id: "s-lgmcxru57d",
    agent: opts.agent ?? "inline",
    flow: opts.flow ?? "inline-s-lgmcxru57d",
    stage: opts.stage ?? "implement",
    config: {
      inline_flow: {
        name: opts.inlineFlowName ?? "inline-s-lgmcxru57d",
        stages: [
          {
            name: opts.stage ?? "implement",
            agent: opts.stageAgent ?? { runtime: "agent-sdk", model: "claude-sonnet-4-6" },
          },
        ],
      },
    },
  };
  return renderToString(
    React.createElement(SessionHeader, {
      sessionId: session.id,
      summary: "Inline dispatch demo",
      status: "running",
      agent: session.agent,
      kvs: [{ k: "flow", v: session.flow }],
      session,
      models: opts.models ?? SAMPLE_MODELS,
    }),
  );
}

describe("SessionHeader inline dispatch", () => {
  test("agent meta block shows runtime · model-display, not the literal `inline`", () => {
    const html = renderInlineSession({});
    expect(html).toContain("agent-sdk · Claude Sonnet 4.6");
    // The literal `inline` should not appear as the agent value (the kv label
    // for "agent" is uppercased "agent" from the K column -- it's fine, but
    // the value "inline" must be gone).
    // Look for the rendered agent kv and verify the value isn't "inline".
    // We look for the immediate sibling of the agent label.
    const m = html.match(/agent<\/span>[^<]*<b[^>]*>([^<]+)<\/b>/);
    expect(m?.[1]).toContain("Claude Sonnet 4.6");
    expect(m?.[1]).not.toBe("inline");
  });

  test("flow meta block renders 'Inline flow' with a tooltip carrying the stage count", () => {
    const html = renderInlineSession({});
    expect(html).toContain("Inline flow");
    expect(html).toContain('data-testid="inline-flow-tooltip"');
    // Tooltip text: `<name> · 1 stage` (single stage, singular form).
    expect(html).toMatch(/title="[^"]*1 stage[^s]/);
    // Synthetic id should not leak into the rendered DOM as the flow value.
    // (It will still appear as the breadcrumb id; we only care about the kv.)
    const meta = html.split("Inline flow")[1] ?? "";
    expect(meta).not.toContain("inline-s-lgmcxru57d");
  });

  test("falls back to the raw model id when the catalog is empty", () => {
    const html = renderInlineSession({ models: [] });
    expect(html).toContain("agent-sdk · claude-sonnet-4-6");
  });

  test("named (non-inline) sessions render unchanged", () => {
    const html = renderToString(
      React.createElement(SessionHeader, {
        sessionId: "s-named",
        summary: "Named dispatch",
        status: "running",
        agent: "worker",
        kvs: [{ k: "flow", v: "bare" }],
      }),
    );
    expect(html).toContain(">worker<");
    expect(html).toContain(">bare<");
    expect(html).not.toContain("Inline flow");
    expect(html).not.toContain('data-testid="inline-flow-tooltip"');
  });

  test("pluralises stage count when the inline flow has multiple stages", () => {
    const session = {
      id: "s-multi",
      agent: "inline",
      flow: "inline-s-multi",
      stage: "first",
      config: {
        inline_flow: {
          name: "demo-flow",
          stages: [
            { name: "first", agent: { runtime: "agent-sdk", model: "sonnet" } },
            { name: "second", agent: { runtime: "agent-sdk", model: "sonnet" } },
            { name: "third", agent: { runtime: "agent-sdk", model: "sonnet" } },
          ],
        },
      },
    };
    const html = renderToString(
      React.createElement(SessionHeader, {
        sessionId: session.id,
        summary: "x",
        status: "running",
        agent: "inline",
        kvs: [{ k: "flow", v: session.flow }],
        session,
        models: SAMPLE_MODELS,
      }),
    );
    expect(html).toMatch(/title="demo-flow · 3 stages"/);
  });
});
