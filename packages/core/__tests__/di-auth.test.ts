/**
 * Regression tests for the six auth-manager DI registrations (DI-2).
 *
 * Ensures the managers that were previously constructed inline in every
 * handler (`new TenantManager(app.db)` etc.) are now:
 *   1. Resolvable from the container's cradle.
 *   2. Exposed as `app.tenants` / `app.teams` / `app.users` /
 *      `app.tenantClaudeAuth` / `app.apiKeys` / `app.tenantPolicyManager`.
 *   3. Overridable via `container.register({ X: asValue(fake) })` so tests
 *      can swap fakes in without mutating the AppContext class.
 */

import { describe, it, expect, afterEach } from "bun:test";
import { asValue } from "awilix";
import { AppContext } from "../app.js";
import { ApiKeyManager, TenantManager, TeamManager, UserManager, TenantPolicyManager } from "../auth/index.js";
import { TenantClaudeAuthManager } from "../auth/tenant-claude-auth.js";

let app: AppContext | null = null;

afterEach(async () => {
  if (app) {
    await app.shutdown();
    app = null;
  }
});

describe("auth-manager DI registrations (DI-2)", async () => {
  it("all six managers resolve from the cradle with the right class", async () => {
    app = await AppContext.forTestAsync();
    await app.boot();

    expect(app.container.cradle.apiKeys).toBeInstanceOf(ApiKeyManager);
    expect(app.container.cradle.tenants).toBeInstanceOf(TenantManager);
    expect(app.container.cradle.teams).toBeInstanceOf(TeamManager);
    expect(app.container.cradle.users).toBeInstanceOf(UserManager);
    expect(app.container.cradle.tenantClaudeAuth).toBeInstanceOf(TenantClaudeAuthManager);
    expect(app.container.cradle.tenantPolicyManager).toBeInstanceOf(TenantPolicyManager);
  });

  it("AppContext accessors return the same singleton instances as the cradle", async () => {
    app = await AppContext.forTestAsync();
    await app.boot();

    expect(app.apiKeys).toBe(app.container.cradle.apiKeys);
    expect(app.tenants).toBe(app.container.cradle.tenants);
    expect(app.teams).toBe(app.container.cradle.teams);
    expect(app.users).toBe(app.container.cradle.users);
    expect(app.tenantClaudeAuth).toBe(app.container.cradle.tenantClaudeAuth);
    expect(app.tenantPolicyManager).toBe(app.container.cradle.tenantPolicyManager);
  });

  it("singleton: accessor returns the same instance on repeated reads", async () => {
    app = await AppContext.forTestAsync();
    await app.boot();

    expect(app.tenants).toBe(app.tenants);
    expect(app.teams).toBe(app.teams);
    expect(app.users).toBe(app.users);
    expect(app.tenantClaudeAuth).toBe(app.tenantClaudeAuth);
  });

  it("container.register({ tenants: asValue(fake) }) intercepts next resolve", async () => {
    app = await AppContext.forTestAsync();
    await app.boot();

    const fake = { list: async () => [{ id: "fake-t", slug: "fake", name: "Fake" }] };
    app.container.register({ tenants: asValue(fake) });

    const resolved = app.container.resolve("tenants") as unknown as typeof fake;
    const rows = await resolved.list();
    expect(rows[0].slug).toBe("fake");
  });
});
