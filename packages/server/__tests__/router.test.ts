import { describe, it, expect, beforeEach } from "bun:test";
import { Router } from "../router.js";
import { createRequest, ErrorCodes } from "../../protocol/types.js";

describe("Router", () => {
  let router: Router;
  beforeEach(() => { router = new Router(); });

  it("dispatches request to registered handler", async () => {
    router.handle("test/method", async (params) => ({ value: params.x }));
    const req = createRequest(1, "test/method", { x: 42 });
    const res = await router.dispatch(req);
    expect((res as any).result).toEqual({ value: 42 });
  });

  it("returns METHOD_NOT_FOUND for unknown method", async () => {
    const req = createRequest(1, "unknown/method", {});
    const res = await router.dispatch(req);
    expect((res as any).error.code).toBe(ErrorCodes.METHOD_NOT_FOUND);
  });

  it("catches handler errors and returns INTERNAL_ERROR", async () => {
    router.handle("test/throws", async () => { throw new Error("boom"); });
    const req = createRequest(1, "test/throws", {});
    const res = await router.dispatch(req);
    expect((res as any).error.code).toBe(ErrorCodes.INTERNAL_ERROR);
    expect((res as any).error.message).toContain("boom");
  });

  it("propagates custom error codes from handlers", async () => {
    router.handle("test/custom-error", async () => {
      const err = new Error("not found");
      (err as any).code = -32002;
      throw err;
    });
    const req = createRequest(1, "test/custom-error", {});
    const res = await router.dispatch(req);
    expect((res as any).error.code).toBe(-32002);
  });

  it("enforces initialization gate", async () => {
    router.handle("guarded/method", async () => ({ ok: true }));
    router.requireInitialization();

    // Before initialize
    const req = createRequest(1, "guarded/method", {});
    const res = await router.dispatch(req);
    expect((res as any).error.code).toBe(ErrorCodes.NOT_INITIALIZED);

    // Initialize always allowed
    router.handle("initialize", async () => ({ server: { name: "ark", version: "0.8.0" } }));
    const initReq = createRequest(0, "initialize", {});
    const initRes = await router.dispatch(initReq);
    expect((initRes as any).result.server.name).toBe("ark");

    // After marking initialized
    router.markInitialized();
    const req2 = createRequest(2, "guarded/method", {});
    const res2 = await router.dispatch(req2);
    expect((res2 as any).result).toEqual({ ok: true });
  });
});
