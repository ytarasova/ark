/**
 * Regression: for_each + mode:spawn + inline flow must substitute iteration
 * vars into the spawned flow's stage `task` (and inline-agent fields)
 * BEFORE the child session is created. The child runs in its own session
 * scope and has no awareness of `stream`/`item`/etc; if the raw template
 * survives, the agent receives a literal "{{stream.objective}}" prompt
 * and gives up without doing any work.
 *
 * Real incident: 3-stream multistage-fanout dispatch where 2 of 3 children
 * exited with "I don't have a task to plan -- {{stream.objective}} is
 * unresolved" and the parent's per_stream stage failed every iteration.
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

describe("for_each + mode:spawn + inline flow templating", () => {
  test("substitutes iterVars into the spawned inline flow's stage.task", async () => {
    const { ForEachDispatcher } = await import("../services/dispatch/dispatch-foreach.js");
    const internals = ForEachDispatcher as unknown as {
      __substituteStageTemplates?: (stage: any, vars: any) => any;
    };
    // The substitution helper isn't exported, but the public surface (spawnChild call
    // site) is what matters. We assert the behaviour by spawning a parent for_each
    // session and inspecting the persisted child config -- the child's
    // session.config.inline_flow.stages[0].task must be the substituted string,
    // not the raw template.
    expect(internals).toBeTruthy();

    const inlineSubFlow = {
      name: "plan-only",
      stages: [
        {
          name: "plan",
          gate: "auto",
          agent: {
            runtime: "agent-sdk",
            model: "test",
            system_prompt: "Plan the work for {{stream.stream_id}}.",
          },
          task: "Objective: {{stream.objective}}",
        },
      ],
    };

    const parent = await app.sessions.create({
      summary: "for_each spawn templating",
      flow: "outer",
      config: {
        inline_flow: {
          name: "outer",
          stages: [
            {
              name: "per_stream",
              for_each: "{{inputs.streams}}",
              mode: "spawn",
              iteration_var: "stream",
              spawn: { flow: inlineSubFlow, inputs: {} },
            },
          ],
        },
        inputs: {
          streams: [
            { stream_id: "alpha", objective: "ship feature A" },
            { stream_id: "beta", objective: "ship feature B" },
          ],
        },
      },
    });
    await app.sessions.update(parent.id, { stage: "per_stream", status: "ready" });
    app.flows.registerInline?.("outer", (parent.config as any).inline_flow);

    // Drive the for_each loop directly via dispatch. We don't need the agent
    // to actually run -- we only care that the spawned children's persisted
    // inline_flow has the templates substituted. Cap the dispatch wait at
    // 3s so that the test fails fast with a useful child-count assertion
    // instead of timing out at the test-runner level.
    try {
      await Promise.race([
        app.sessionService.dispatch(parent.id),
        new Promise((_, reject) => setTimeout(() => reject(new Error("dispatch wait cap")), 3000)),
      ]);
    } catch {
      // dispatch attempts to launch agents; on a unit-test compute that may
      // fail or hang. The substitution happens BEFORE launch, so child
      // sessions are already created with the substituted flow.
    }
    // The for_each may be queued asynchronously after the dispatch returns;
    // give the spawn loop a moment to write child rows.
    await new Promise((r) => setTimeout(r, 250));

    // Find children spawned by the for_each. The first iteration's dispatch
    // may abort the loop in this test environment (no real compute) -- we
    // only need to prove that whatever child WAS spawned has the templates
    // already resolved.
    const all = await app.sessions.list({});
    const children = all.filter((s: any) => s.parent_id === parent.id);
    expect(children.length).toBeGreaterThan(0);

    for (const c of children) {
      const task = c.config?.inline_flow?.stages?.[0]?.task;
      const prompt = c.config?.inline_flow?.stages?.[0]?.agent?.system_prompt;
      expect(task).not.toContain("{{");
      expect(prompt).not.toContain("{{");
      // Each child's resolved task references one of the two objectives.
      expect(["Objective: ship feature A", "Objective: ship feature B"]).toContain(task);
      expect(["Plan the work for alpha.", "Plan the work for beta."]).toContain(prompt);
    }
  });
});
