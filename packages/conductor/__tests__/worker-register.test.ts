/**
 * Tests for worker/* JSON-RPC handlers.
 *
 * The worker registry is a hosted-mode-only service. In the test profile
 * (local SQLite) the DI container has no `workerRegistry` entry and
 * `app.workerRegistry` throws "hosted mode only". We inject a real
 * WorkerRegistry instance via the awilix escape hatch -- the same pattern
 * used by packages/core/__tests__/scheduler.test.ts -- so the handler tests
 * exercise the full registry path without requiring a hosted deployment.
 *
 * A separate group verifies that the handler returns the expected INTERNAL_ERROR
 * when the registry is not injected (simulating local-mode behaviour).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { asValue } from "awilix";
import { AppContext } from "../../core/app.js";
import { WorkerRegistry } from "../../core/hosted/worker-registry.js";
import { Router } from "../router.js";
import { registerWorkerHandlers } from "../handlers/worker.js";
import { createRequest, ErrorCodes, type JsonRpcError, type JsonRpcResponse } from "../../protocol/types.js";

let app: AppContext;
let router: Router;

beforeAll(async () => {
  app = await AppContext.forTestAsync();
  await app.boot();

  // Inject a real WorkerRegistry using the standard DI escape hatch so the
  // handler can reach it in test (local) mode.
  const registry = new WorkerRegistry(app.db);
  app.container.register({ workerRegistry: asValue(registry) });
});

afterAll(async () => {
  await app?.shutdown();
});

beforeEach(() => {
  router = new Router();
  registerWorkerHandlers(router, app);
});

describe("worker/register", () => {
  it("registers a worker and returns status=registered", async () => {
    const res = await router.dispatch(
      createRequest(1, "worker/register", {
        id: "w-test-1",
        url: "http://worker1:19300",
      }),
    );
    const result = (res as JsonRpcResponse).result as Record<string, unknown>;
    expect(result.status).toBe("registered");
    expect(result.id).toBe("w-test-1");
  });

  it("persists the worker so worker/list returns it", async () => {
    await router.dispatch(
      createRequest(1, "worker/register", {
        id: "w-test-persist",
        url: "http://wpersist:19300",
        capacity: 3,
      }),
    );

    const listRes = await router.dispatch(createRequest(2, "worker/list", {}));
    const { workers } = (listRes as JsonRpcResponse).result as { workers: Array<{ id: string }> };
    expect(workers.some((w) => w.id === "w-test-persist")).toBe(true);
  });

  it("returns INVALID_PARAMS when id is missing", async () => {
    const res = await router.dispatch(createRequest(1, "worker/register", { url: "http://worker:19300" }));
    const err = (res as JsonRpcError).error;
    expect(err).toBeDefined();
    expect(err.code).toBe(ErrorCodes.INVALID_PARAMS);
  });

  it("returns INVALID_PARAMS when url is missing", async () => {
    const res = await router.dispatch(createRequest(1, "worker/register", { id: "w-nurl" }));
    const err = (res as JsonRpcError).error;
    expect(err).toBeDefined();
    expect(err.code).toBe(ErrorCodes.INVALID_PARAMS);
  });

  it("accepts optional fields (capacity, compute_name, tenant_id, metadata)", async () => {
    const res = await router.dispatch(
      createRequest(1, "worker/register", {
        id: "w-test-full",
        url: "http://wfull:19300",
        capacity: 10,
        compute_name: "ec2-us-east-1",
        tenant_id: "t-acme",
        metadata: { region: "us-east-1" },
      }),
    );
    const result = (res as JsonRpcResponse).result as Record<string, unknown>;
    expect(result.status).toBe("registered");
    expect(result.id).toBe("w-test-full");
  });

  it("re-registering an existing worker returns registered (upsert)", async () => {
    await router.dispatch(createRequest(1, "worker/register", { id: "w-upsert", url: "http://wupsert:19300" }));
    const res = await router.dispatch(
      createRequest(2, "worker/register", { id: "w-upsert", url: "http://wupsert-new:19300" }),
    );
    const result = (res as JsonRpcResponse).result as Record<string, unknown>;
    expect(result.status).toBe("registered");
  });
});

describe("worker/register -- hosted-mode guard", () => {
  it("returns INTERNAL_ERROR when worker registry is not available (local mode)", async () => {
    // Boot a fresh app without injecting a WorkerRegistry so the accessor
    // throws "hosted mode only" -- exactly what happens in local-mode production.
    const localApp = await AppContext.forTestAsync();
    await localApp.boot();

    try {
      const localRouter = new Router();
      registerWorkerHandlers(localRouter, localApp);

      const res = await localRouter.dispatch(
        createRequest(1, "worker/register", { id: "w-noop", url: "http://noop:19300" }),
      );
      const err = (res as JsonRpcError).error;
      expect(err).toBeDefined();
      expect(err.code).toBe(ErrorCodes.INTERNAL_ERROR);
      expect(err.message).toMatch(/hosted mode/i);
    } finally {
      await localApp.shutdown();
    }
  });
});

describe("worker/heartbeat", () => {
  it("returns status=ok for a registered worker", async () => {
    await router.dispatch(createRequest(1, "worker/register", { id: "w-hb", url: "http://whb:19300" }));
    const res = await router.dispatch(createRequest(2, "worker/heartbeat", { id: "w-hb" }));
    const result = (res as JsonRpcResponse).result as Record<string, unknown>;
    expect(result.status).toBe("ok");
  });

  it("returns INVALID_PARAMS when id is missing", async () => {
    const res = await router.dispatch(createRequest(1, "worker/heartbeat", {}));
    const err = (res as JsonRpcError).error;
    expect(err.code).toBe(ErrorCodes.INVALID_PARAMS);
  });
});

describe("worker/deregister", () => {
  it("deregisters a worker and returns status=deregistered", async () => {
    await router.dispatch(createRequest(1, "worker/register", { id: "w-dereg", url: "http://wdereg:19300" }));
    const res = await router.dispatch(createRequest(2, "worker/deregister", { id: "w-dereg" }));
    const result = (res as JsonRpcResponse).result as Record<string, unknown>;
    expect(result.status).toBe("deregistered");
    expect(result.id).toBe("w-dereg");
  });

  it("returns INVALID_PARAMS when id is missing", async () => {
    const res = await router.dispatch(createRequest(1, "worker/deregister", {}));
    const err = (res as JsonRpcError).error;
    expect(err.code).toBe(ErrorCodes.INVALID_PARAMS);
  });
});

describe("worker/list", () => {
  it("returns a workers array", async () => {
    const res = await router.dispatch(createRequest(1, "worker/list", {}));
    const result = (res as JsonRpcResponse).result as Record<string, unknown>;
    expect(Array.isArray(result.workers)).toBe(true);
  });
});
