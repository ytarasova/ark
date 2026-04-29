/**
 * Regression: advance() must coerce inline-agent specs to a string before
 * writing them to session.agent. The column is `string | null`; when the
 * next stage carries an inline agent definition (object), the bind threw
 * with "Binding expected string, TypedArray, boolean, number, bigint or
 * null" and every multi-stage inline-flow dispatch wedged at stage 1.
 *
 * Real incident: 3-stream parallel dispatch of plan-then-implement
 * children. Each child finished `plan`, fired SessionEnd, the conductor
 * called mediateStageHandoff -> advance, advance crashed on the bind.
 * Sessions stayed at status=ready / stage=plan forever.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { AppContext } from "../app.js";

let app: AppContext;

beforeAll(async () => {
  app = await AppContext.forTestAsync();
  await app.boot();
});

afterAll(async () => {
  await app?.shutdown();
}, 30_000);

describe("advance() with inline agent in next stage", () => {
  test("persists 'inline' to session.agent when next stage's agent is an object", async () => {
    // Build an inline-flow definition with two stages whose `agent` fields
    // are object literals (not named-agent strings). The bug fires when
    // advance copies that object into the agent column.
    const inlineFlow = {
      name: "two-stage",
      stages: [
        {
          name: "plan",
          gate: "auto",
          agent: {
            runtime: "agent-sdk",
            model: "sonnet",
            system_prompt: "plan",
          },
        },
        {
          name: "implement",
          gate: "auto",
          agent: {
            runtime: "agent-sdk",
            model: "sonnet",
            system_prompt: "implement",
          },
        },
      ],
    };
    const session = await app.sessions.create({
      summary: "advance inline-agent regression",
      flow: "two-stage",
      config: { inline_flow: inlineFlow },
    });
    await app.sessions.update(session.id, { stage: "plan", status: "ready", agent: "inline" });

    // Inline flows must be registered with the ephemeral store so getStage /
    // getStageAction can find them -- production paths do this via
    // registerInline at dispatch time.
    app.flows.registerInline?.("two-stage", inlineFlow as any);

    // Advance: should NOT crash binding the object into the column.
    const result = await app.stageAdvance.advance(session.id, false);
    expect(result.ok).toBe(true);

    const after = await app.sessions.get(session.id);
    expect(after?.stage).toBe("implement");
    // The placeholder string lands in the column; the actual agent spec
    // stays on session.config.inline_flow.stages[i].agent.
    expect(after?.agent).toBe("inline");
  });
});
