/**
 * Tests for inline-flow / inline-agent dispatch via `session/start`.
 *
 * Verifies that the RPC handler accepts:
 *   - A literal flow object (`flow: { stages: [...] }`)
 *   - A literal agent object on stage.agent (`{ runtime, model, system_prompt }`)
 *
 * The handler persists the inline flow under `session.config.inline_flow`
 * and registers it on the ephemeral flow overlay under `inline-<sessionId>`
 * so subsequent stage lookups resolve through the overlay. Dispatch is not
 * exercised end-to-end -- we just assert the session was created and the
 * ephemeral overlay now carries the flow.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { AppContext } from "../../core/app.js";
import { registerSessionHandlers } from "../handlers/session.js";
import { Router } from "../router.js";
import { createRequest, type JsonRpcResponse, type JsonRpcError } from "../../protocol/types.js";

let app: AppContext;
let router: Router;

beforeAll(async () => {
  app = await AppContext.forTestAsync();
  await app.boot();
});

afterAll(async () => {
  await app?.shutdown();
});

beforeEach(() => {
  router = new Router();
  registerSessionHandlers(router, app);
});

describe("session/start: inline flow payloads", () => {
  it("accepts an inline flow object and registers it on the overlay", async () => {
    const inlineFlow = {
      name: "my-inline",
      description: "built-on-the-wire",
      stages: [
        {
          name: "main",
          gate: "auto",
          agent: "worker",
        },
      ],
    };
    const req = createRequest(1, "session/start", {
      summary: "inline flow test",
      repo: ".",
      flow: inlineFlow,
    });
    const res = await router.dispatch(req);
    const result = (res as JsonRpcResponse).result as Record<string, unknown>;
    expect(result.session).toBeDefined();
    const session = result.session as Record<string, unknown>;

    // Flow column is rewritten to the synthetic per-session name.
    const flowName = session.flow as string;
    expect(flowName.startsWith("inline-")).toBe(true);

    // Ephemeral overlay now carries the definition.
    const def = app.flows.get(flowName);
    expect(def).toBeDefined();
    expect(def?.stages[0]?.name).toBe("main");
  });

  it("accepts an inline agent at stage.agent", async () => {
    const inlineFlow = {
      name: "with-inline-agent",
      stages: [
        {
          name: "main",
          gate: "auto",
          agent: {
            runtime: "agent-sdk",
            model: "sonnet",
            system_prompt: "You are inline.",
          },
        },
      ],
    };
    const req = createRequest(2, "session/start", {
      summary: "inline agent test",
      repo: ".",
      flow: inlineFlow,
    });
    const res = await router.dispatch(req);
    const result = (res as JsonRpcResponse).result as Record<string, unknown>;
    const session = result.session as Record<string, unknown>;
    const flowName = session.flow as string;
    const def = app.flows.get(flowName);
    const stage = def?.stages[0] as Record<string, unknown> | undefined;
    expect(stage?.agent).toBeDefined();
    expect(typeof stage?.agent).toBe("object");
    const agent = stage?.agent as Record<string, unknown>;
    expect(agent.runtime).toBe("agent-sdk");
    expect(agent.model).toBe("sonnet");
  });

  it("rejects an inline flow with zero stages", async () => {
    const req = createRequest(3, "session/start", {
      summary: "bad inline",
      repo: ".",
      flow: { name: "bad", stages: [] },
    });
    const res = await router.dispatch(req);
    const err = (res as JsonRpcError).error;
    // Either zod schema rejects (stages.min(1)) or the server throws --
    // both land as a structured error response.
    expect(err).toBeDefined();
  });
});
