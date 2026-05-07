/**
 * Tests for per-method role gating in the JSON-RPC router.
 *
 * The router enforces a prefix-based role convention:
 *   - worker/*  -> "worker" or "admin" only
 *   - admin/*   -> "admin" only
 *   - anything else -> any role except "worker"
 *   - "initialize" (no prefix) -> allowed for all roles
 *
 * FORBIDDEN (-32006) is returned when a caller's role does not permit the
 * requested method.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { Router } from "../router.js";
import { createRequest, ErrorCodes, type JsonRpcResponse, type JsonRpcError } from "../../protocol/types.js";
import type { TenantContext } from "../../core/auth/context.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeCtx(role: TenantContext["role"]): TenantContext {
  return {
    tenantId: "t-test",
    userId: "u-test",
    role,
    isAdmin: role === "admin",
  };
}

// ── Setup ────────────────────────────────────────────────────────────────────

let router: Router;

beforeEach(() => {
  router = new Router();

  // Register a stub for each method prefix used in the tests.
  router.handle("worker/heartbeat", async () => ({ status: "ok" }));
  router.handle("session/start", async () => ({ session: { id: "s-1" } }));
  router.handle("admin/apikey/list", async () => ({ keys: [] }));
  router.handle("initialize", async () => ({ server: { name: "ark" } }));
});

// ── Worker role ──────────────────────────────────────────────────────────────

describe("worker role", () => {
  it("can call worker/heartbeat", async () => {
    const res = await router.dispatch(createRequest(1, "worker/heartbeat", {}), undefined, makeCtx("worker"));
    // Must not be a FORBIDDEN error -- a domain result or any non-FORBIDDEN code is acceptable.
    const err = (res as JsonRpcError).error;
    expect(err?.code).not.toBe(ErrorCodes.FORBIDDEN);
    if (!err) {
      expect((res as JsonRpcResponse).result).toBeDefined();
    }
  });

  it("is blocked from session/start with FORBIDDEN", async () => {
    const res = await router.dispatch(createRequest(1, "session/start", {}), undefined, makeCtx("worker"));
    const err = (res as JsonRpcError).error;
    expect(err).toBeDefined();
    expect(err.code).toBe(ErrorCodes.FORBIDDEN);
    expect(err.message).toBe("forbidden");
  });

  it("is blocked from admin/apikey/list with FORBIDDEN", async () => {
    const res = await router.dispatch(createRequest(1, "admin/apikey/list", {}), undefined, makeCtx("worker"));
    const err = (res as JsonRpcError).error;
    expect(err).toBeDefined();
    expect(err.code).toBe(ErrorCodes.FORBIDDEN);
  });

  it("can call initialize (handshake, no prefix)", async () => {
    const res = await router.dispatch(createRequest(0, "initialize", {}), undefined, makeCtx("worker"));
    const err = (res as JsonRpcError).error;
    expect(err?.code).not.toBe(ErrorCodes.FORBIDDEN);
  });
});

// ── User / member role ───────────────────────────────────────────────────────

describe("member role (user tier)", () => {
  it("can call session/start", async () => {
    const res = await router.dispatch(createRequest(1, "session/start", {}), undefined, makeCtx("member"));
    const err = (res as JsonRpcError).error;
    expect(err?.code).not.toBe(ErrorCodes.FORBIDDEN);
  });

  it("is blocked from worker/heartbeat with FORBIDDEN", async () => {
    const res = await router.dispatch(createRequest(1, "worker/heartbeat", {}), undefined, makeCtx("member"));
    const err = (res as JsonRpcError).error;
    expect(err).toBeDefined();
    expect(err.code).toBe(ErrorCodes.FORBIDDEN);
  });

  it("is blocked from admin/apikey/list with FORBIDDEN", async () => {
    const res = await router.dispatch(createRequest(1, "admin/apikey/list", {}), undefined, makeCtx("member"));
    const err = (res as JsonRpcError).error;
    expect(err).toBeDefined();
    expect(err.code).toBe(ErrorCodes.FORBIDDEN);
  });

  it("can call initialize", async () => {
    const res = await router.dispatch(createRequest(0, "initialize", {}), undefined, makeCtx("member"));
    const err = (res as JsonRpcError).error;
    expect(err?.code).not.toBe(ErrorCodes.FORBIDDEN);
  });
});

describe("viewer role (user tier)", () => {
  it("can call session/start (viewer is user-tier)", async () => {
    const res = await router.dispatch(createRequest(1, "session/start", {}), undefined, makeCtx("viewer"));
    const err = (res as JsonRpcError).error;
    expect(err?.code).not.toBe(ErrorCodes.FORBIDDEN);
  });

  it("is blocked from worker/heartbeat with FORBIDDEN", async () => {
    const res = await router.dispatch(createRequest(1, "worker/heartbeat", {}), undefined, makeCtx("viewer"));
    const err = (res as JsonRpcError).error;
    expect(err).toBeDefined();
    expect(err.code).toBe(ErrorCodes.FORBIDDEN);
  });
});

// ── Admin role ───────────────────────────────────────────────────────────────

describe("admin role (superset)", () => {
  it("can call session/start", async () => {
    const res = await router.dispatch(createRequest(1, "session/start", {}), undefined, makeCtx("admin"));
    const err = (res as JsonRpcError).error;
    expect(err?.code).not.toBe(ErrorCodes.FORBIDDEN);
  });

  it("can call worker/heartbeat", async () => {
    const res = await router.dispatch(createRequest(1, "worker/heartbeat", {}), undefined, makeCtx("admin"));
    const err = (res as JsonRpcError).error;
    expect(err?.code).not.toBe(ErrorCodes.FORBIDDEN);
  });

  it("can call admin/apikey/list", async () => {
    const res = await router.dispatch(createRequest(1, "admin/apikey/list", {}), undefined, makeCtx("admin"));
    const err = (res as JsonRpcError).error;
    expect(err?.code).not.toBe(ErrorCodes.FORBIDDEN);
  });

  it("can call initialize", async () => {
    const res = await router.dispatch(createRequest(0, "initialize", {}), undefined, makeCtx("admin"));
    const err = (res as JsonRpcError).error;
    expect(err?.code).not.toBe(ErrorCodes.FORBIDDEN);
  });
});

// ── No ctx supplied (defaults to local-admin) ────────────────────────────────

describe("no ctx (local / test default -> admin)", () => {
  it("can call any method when no ctx is supplied (defaults to admin)", async () => {
    const sessionRes = await router.dispatch(createRequest(1, "session/start", {}));
    expect((sessionRes as JsonRpcError).error?.code).not.toBe(ErrorCodes.FORBIDDEN);

    const workerRes = await router.dispatch(createRequest(2, "worker/heartbeat", {}));
    expect((workerRes as JsonRpcError).error?.code).not.toBe(ErrorCodes.FORBIDDEN);

    const adminRes = await router.dispatch(createRequest(3, "admin/apikey/list", {}));
    expect((adminRes as JsonRpcError).error?.code).not.toBe(ErrorCodes.FORBIDDEN);
  });
});
