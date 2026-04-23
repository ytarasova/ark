/**
 * Regression test: trigger/* handlers must resolve the caller's tenant
 * from `ctx.tenantId` and ignore any body-level `tenant` override.
 *
 * Before the fix, `trigger/enable` accepted `params.tenant` and fell
 * through to a hardcoded `"default"` when absent, letting any caller
 * enable / disable any tenant's trigger.
 *
 * Batch 1, Server P0-2 (docs/2026-04-22-code-quality-audit.md).
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { AppContext } from "../../core/app.js";
import { Router } from "../router.js";
import { registerTriggerHandlers } from "../handlers/triggers.js";
import { createRequest, type JsonRpcResponse, type JsonRpcError } from "../../protocol/types.js";
import type { TenantContext } from "../../core/auth/context.js";

let app: AppContext;
let router: Router;

beforeAll(async () => {
  app = await AppContext.forTestAsync();
  await app.boot();

  // Seed two tenant-scoped trigger YAMLs on disk.
  const triggersDir = join(app.config.arkDir, "triggers");
  for (const tenant of ["tenant-a", "tenant-b"]) {
    const dir = join(triggersDir, tenant);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `${tenant}-hook.yaml`),
      [`name: ${tenant}-hook`, "source: github", "event: issues", "flow: default", "enabled: true"].join("\n"),
    );
  }

  router = new Router();
  registerTriggerHandlers(router, app);
  router.markInitialized();
});

afterAll(async () => {
  await app?.shutdown();
});

function asCtx(tenantId: string, role: TenantContext["role"] = "admin"): TenantContext {
  return { tenantId, userId: "u-test", role, isAdmin: role === "admin" };
}

describe("trigger/* handlers: tenant isolation", () => {
  it("trigger/list returns only the caller's tenant triggers (ignores body tenant)", async () => {
    const res = (await router.dispatch(
      createRequest(1, "trigger/list", { tenant: "tenant-b" }),
      undefined,
      asCtx("tenant-a"),
    )) as JsonRpcResponse;
    expect(res.result).toBeDefined();
    const triggers = (res.result as any).triggers as Array<{ name: string }>;
    // Must include tenant-a's trigger, must NOT include tenant-b's.
    expect(triggers.some((t) => t.name === "tenant-a-hook")).toBe(true);
    expect(triggers.some((t) => t.name === "tenant-b-hook")).toBe(false);
  });

  it("trigger/get ignores body tenant and uses ctx.tenantId", async () => {
    // Request tenant-b's hook while calling as tenant-a -> NOT_FOUND,
    // even though the body claims tenant-b.
    const res = (await router.dispatch(
      createRequest(1, "trigger/get", { name: "tenant-b-hook", tenant: "tenant-b" }),
      undefined,
      asCtx("tenant-a"),
    )) as JsonRpcError;
    expect(res.error).toBeDefined();
    expect(res.error?.message).toMatch(/not found/i);
  });

  it("trigger/enable with body-level tenant override is ignored", async () => {
    // Attacker: logged in as tenant-a, tries to disable tenant-b's trigger
    // by passing `tenant: 'tenant-b'`. Pre-fix: would succeed. Post-fix:
    // the ctx-bound tenant (tenant-a) is used, `tenant-b-hook` is not
    // visible to tenant-a, so NOT_FOUND comes back.
    const evil = (await router.dispatch(
      createRequest(1, "trigger/enable", { name: "tenant-b-hook", tenant: "tenant-b" }),
      undefined,
      asCtx("tenant-a"),
    )) as JsonRpcError;
    expect(evil.error).toBeDefined();
    expect(evil.error?.message).toMatch(/not found/i);

    // And the legitimate owner (tenant-b) can still toggle their trigger.
    const honest = (await router.dispatch(
      createRequest(1, "trigger/enable", { name: "tenant-b-hook" }),
      undefined,
      asCtx("tenant-b"),
    )) as JsonRpcResponse;
    expect(honest.result).toBeDefined();
    expect((honest.result as any).ok).toBe(true);
  });

  it("trigger/disable with body-level tenant override is ignored", async () => {
    const evil = (await router.dispatch(
      createRequest(1, "trigger/disable", { name: "tenant-a-hook", tenant: "tenant-a" }),
      undefined,
      asCtx("tenant-b"),
    )) as JsonRpcError;
    expect(evil.error).toBeDefined();
    expect(evil.error?.message).toMatch(/not found/i);
  });

  it("trigger/test with body-level tenant override is ignored", async () => {
    const evil = (await router.dispatch(
      createRequest(1, "trigger/test", {
        name: "tenant-a-hook",
        payload: {},
        tenant: "tenant-a",
      }),
      undefined,
      asCtx("tenant-b"),
    )) as JsonRpcError;
    expect(evil.error).toBeDefined();
    expect(evil.error?.message).toMatch(/not found/i);
  });
});
