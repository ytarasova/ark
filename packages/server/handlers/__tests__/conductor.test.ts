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

beforeEach(() => {
  router = new Router();
  registerConductorHandlers(router, app);
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
