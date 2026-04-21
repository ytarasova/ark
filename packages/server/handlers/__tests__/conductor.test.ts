/**
 * conductor/* RPC handler tests -- happy path + error path.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { AppContext } from "../../../core/app.js";
import { Router } from "../../router.js";
import { registerConductorHandlers } from "../conductor.js";
import { createRequest, ErrorCodes, type JsonRpcError, type JsonRpcResponse } from "../../../protocol/types.js";

let app: AppContext;
let router: Router;

beforeAll(async () => {
  app = await AppContext.forTestAsync();
  await app.boot();
});

afterAll(async () => {
  await app?.shutdown();
});

beforeEach(async () => {
  router = new Router();
  registerConductorHandlers(router, app);
  await app.knowledge.clear({ type: "learning" });
});

function ok(res: unknown): Record<string, any> {
  return (res as JsonRpcResponse).result as Record<string, any>;
}

describe("conductor/status", () => {
  it("returns a shape with running + port regardless of conductor state", async () => {
    const res = ok(await router.dispatch(createRequest(1, "conductor/status", {})));
    expect(typeof res.running).toBe("boolean");
    expect(typeof res.port).toBe("number");
    expect(res.port).toBeGreaterThan(0);
  });
});

describe("conductor/learn + learnings", () => {
  it("records a new learning and lists it back", async () => {
    const add = ok(
      await router.dispatch(
        createRequest(1, "conductor/learn", { title: "prefer tmux", description: "tmux is mandatory" }),
      ),
    );
    expect(add.ok).toBe(true);
    expect(add.learning.title).toBe("prefer tmux");
    expect(add.learning.recurrence).toBe(1);
    expect(add.learning.promoted).toBe(false);

    const list = ok(await router.dispatch(createRequest(2, "conductor/learnings", {})));
    expect(list.learnings.length).toBe(1);
    expect(list.learnings[0].title).toBe("prefer tmux");
  });

  it("promotes a learning after 3 recurrences", async () => {
    for (let i = 0; i < 3; i++) {
      await router.dispatch(createRequest(i + 1, "conductor/learn", { title: "flaky test pattern" }));
    }
    const list = ok(await router.dispatch(createRequest(10, "conductor/learnings", {})));
    expect(list.learnings.length).toBe(1);
    expect(list.learnings[0].recurrence).toBe(3);
    expect(list.learnings[0].promoted).toBe(true);
  });

  it("conductor/learn without title returns INVALID_PARAMS", async () => {
    const res = (await router.dispatch(createRequest(1, "conductor/learn", {}))) as JsonRpcError;
    expect(res.error?.code).toBe(ErrorCodes.INVALID_PARAMS);
  });
});

describe("conductor/bridge + notify", () => {
  it("returns ok:false when no bridge config exists", async () => {
    // AppContext.forTestAsync() uses a fresh temp arkDir, so bridge.json is
    // absent -- this exercises the not-configured error path.
    const bridge = ok(await router.dispatch(createRequest(1, "conductor/bridge", {})));
    expect(bridge.ok).toBe(false);
    expect(bridge.message).toMatch(/bridge/i);

    const notify = ok(await router.dispatch(createRequest(2, "conductor/notify", { message: "hi" })));
    expect(notify.ok).toBe(false);
  });

  it("conductor/notify without message returns INVALID_PARAMS", async () => {
    const res = (await router.dispatch(createRequest(1, "conductor/notify", {}))) as JsonRpcError;
    expect(res.error?.code).toBe(ErrorCodes.INVALID_PARAMS);
  });
});
