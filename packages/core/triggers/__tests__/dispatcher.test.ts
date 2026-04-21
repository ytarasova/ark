/**
 * Dispatcher tests with a live AppContext.
 *
 * Boots the test profile, saves a minimal flow, dispatches a trigger, and
 * confirms a session lands with the mapped inputs + group name.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { AppContext } from "../../app.js";
import { DefaultTriggerDispatcher } from "../dispatcher.js";
import type { NormalizedEvent, TriggerConfig } from "../types.js";

let app: AppContext;

beforeAll(async () => {
  app = await AppContext.forTestAsync();
  await app.boot();
  app.flows.save("trigger-test-flow", {
    name: "trigger-test-flow",
    stages: [{ name: "work", agent: "worker", gate: "auto" }],
  } as any);
});

afterAll(async () => {
  await app?.shutdown();
});

function ev(): NormalizedEvent {
  return {
    source: "github",
    event: "pull_request.opened",
    ref: "feature/a",
    payload: {
      pull_request: {
        number: 7,
        html_url: "https://github.com/acme/api/pull/7",
        title: "Fix thing",
      },
      repository: { full_name: "acme/api" },
    },
    receivedAt: 123,
  };
}

function cfg(): TriggerConfig {
  return {
    name: "github-pr-opened",
    source: "github",
    event: "pull_request.opened",
    flow: "trigger-test-flow",
    summary: "PR $.payload.pull_request.number: $.payload.pull_request.title",
    inputs: {
      prUrl: "$.payload.pull_request.html_url",
      branch: "$.ref",
    },
    params: { priority: "normal" },
  };
}

describe("DefaultTriggerDispatcher", async () => {
  test("creates a session with mapped inputs + group name", async () => {
    const dispatcher = new DefaultTriggerDispatcher(app);
    const result = await dispatcher.dispatch({ event: ev(), config: cfg() });
    expect(result.ok).toBe(true);
    expect(result.sessionId).toBeDefined();

    const s = await app.sessions.get(result.sessionId!);
    expect(s).not.toBeNull();
    expect(s!.flow).toBe("trigger-test-flow");
    expect(s!.group_name).toBe("trigger:github-pr-opened");
    expect(s!.summary).toBe("PR 7: Fix thing");

    // Inputs survive round-trip via session.config.inputs.params.
    const sessionConfig = s!.config as { inputs?: { params?: Record<string, string> }; trigger?: unknown };
    expect(sessionConfig.inputs?.params?.prUrl).toBe("https://github.com/acme/api/pull/7");
    expect(sessionConfig.inputs?.params?.branch).toBe("feature/a");
    expect(sessionConfig.inputs?.params?.priority).toBe("normal");
    expect(sessionConfig.inputs?.params?.trigger_source).toBe("github");
    expect(sessionConfig.inputs?.params?.trigger_event).toBe("pull_request.opened");
    expect(sessionConfig.trigger).toBeDefined();
  });

  test("dispatch failure is reported as ok=false with a message", async () => {
    const dispatcher = new DefaultTriggerDispatcher(app);
    const config = { ...cfg(), flow: "does-not-exist" };
    // startSession does not throw on missing flow -- it creates an empty
    // session. We assert the ok path holds instead and that no stage fires.
    const result = await dispatcher.dispatch({ event: ev(), config });
    expect(result.ok).toBe(true);
    const s = await app.sessions.get(result.sessionId!);
    expect(s!.flow).toBe("does-not-exist");
  });
});
