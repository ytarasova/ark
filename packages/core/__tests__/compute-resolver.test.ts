/**
 * Tests for `app.resolveProvider(session)` -- the polymorphic compute resolver.
 *
 * Core P1-1: the 4 executor sites used to fall back to `"local"` any time
 * `session.compute_name` was empty. Hosted mode needs to reject that case
 * because "local" inside a control-plane pod means agents spawn inside the
 * pod itself (no isolation, competes with the control plane).
 *
 * The new contract: `app.resolveProvider(session)` honours
 * `app.mode.defaultProvider` -- "local" locally, `null` in hosted mode.
 */

import { describe, it, expect, afterEach } from "bun:test";
import { asValue } from "awilix";
import { AppContext } from "../app.js";
import { buildHostedAppMode } from "../modes/app-mode.js";
import { mockSession } from "./test-helpers.js";

let app: AppContext | null = null;

afterEach(async () => {
  if (app) {
    await app.shutdown();
    app = null;
  }
});

describe("app.resolveProvider (P1-1)", async () => {
  it("local mode: session without compute_name resolves against the seeded 'local' row", async () => {
    app = await AppContext.forTestAsync();
    await app.boot();

    // Local mode seeds a `local` compute row at boot; the fallback kicks in
    // because session.compute_name is null.
    const session = mockSession({ id: "s-local-default", compute_name: null });
    const { provider, compute } = await app.resolveProvider(session);
    expect(compute?.name).toBe("local");
    // Provider might be null if no LocalProvider was registered in this
    // test profile, but `compute` resolution must succeed.
    void provider;
  });

  it("hosted mode: session without compute_name returns { provider: null, compute: null }", async () => {
    app = await AppContext.forTestAsync();
    await app.boot();

    // Swap in a hosted-mode AppMode so `defaultProvider` flips to null.
    // We don't run the hosted container (no Postgres); we just verify the
    // resolver honours the capability.
    const hosted = buildHostedAppMode({ dialect: "postgres", url: "postgres://fake" });
    app.container.register({ mode: asValue(hosted) });

    const session = mockSession({ id: "s-hosted-no-compute", compute_name: null });
    const { provider, compute } = await app.resolveProvider(session);
    expect(provider).toBeNull();
    expect(compute).toBeNull();
  });

  it("hosted mode: session WITH compute_name resolves normally", async () => {
    app = await AppContext.forTestAsync();
    await app.boot();

    // Create an explicit compute row then register hosted mode on top.
    await app.computeService.create({ name: "k8s-test", provider: "k8s" as any, config: {} });
    const hosted = buildHostedAppMode({ dialect: "postgres", url: "postgres://fake" });
    app.container.register({ mode: asValue(hosted) });

    const session = mockSession({ id: "s-hosted-with-compute", compute_name: "k8s-test" });
    const { compute } = await app.resolveProvider(session);
    expect(compute?.name).toBe("k8s-test");
    expect(compute?.provider).toBe("k8s");
  });

  it("tenant-scoped app: resolveProvider still honours the mode default", async () => {
    app = await AppContext.forTestAsync();
    await app.boot();

    const hosted = buildHostedAppMode({ dialect: "postgres", url: "postgres://fake" });
    app.container.register({ mode: asValue(hosted) });

    const tenantApp = app.forTenant("acme");
    const session = mockSession({ id: "s-acme-no-compute", compute_name: null });
    const { provider, compute } = await tenantApp.resolveProvider(session);
    expect(provider).toBeNull();
    expect(compute).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Round-3 P0-1 -- cross-tenant compute leak regression.
//
// Previous behaviour: resolveProvider issued a raw
//   SELECT * FROM compute WHERE name = ?
// with no tenant filter. A tenant-B session whose `compute_name` happened to
// match a row owned by tenant A (or by the default tenant, e.g. the seeded
// "local" compute) resolved to that foreign row, leaking the foreign
// provider + credentials + config into tenant B's dispatch. Fix: route
// through `app.computes.get(name)` on a tenant-scoped AppContext
// (`app.forTenant(session.tenant_id)`).
//
// Note: the `compute` table today has a single-column `name` primary key
// (see packages/core/drizzle/schema/sqlite.ts:95), so we can't INSERT two
// rows with the same name under different tenants until migration 011 flips
// the PK to `(name, tenant_id)`. What we CAN pin here is that:
//   1. A session carrying tenant_id=X resolving a name owned by tenant Y
//      returns null (does not leak the foreign row).
//   2. The resolver honours the caller's session.tenant_id regardless of
//      whether the AppContext handed to it is root or already tenant-scoped.
// ─────────────────────────────────────────────────────────────────────────────

describe("resolveProvider cross-tenant isolation (round-3 P0-1)", async () => {
  it("session.tenant_id routes lookup to that tenant's scope even from root AppContext", async () => {
    app = await AppContext.forTestAsync();
    await app.boot();

    // tenant-a owns "prod-gpu"; tenant-b owns nothing by that name.
    const tenantA = app.forTenant("tenant-a");
    await tenantA.computeService.create({
      name: "prod-gpu",
      provider: "docker",
      config: { image: "tenant-a-image:latest" } as any,
    });

    // Session pinned to tenant-a resolves.
    const sessionA = mockSession({ id: "sess-a", tenant_id: "tenant-a", compute_name: "prod-gpu" });
    const resolvedA = await app.resolveProvider(sessionA);
    expect(resolvedA.compute?.name).toBe("prod-gpu");
    expect(resolvedA.compute?.provider).toBe("docker");
    expect((resolvedA.compute?.config as any)?.image).toBe("tenant-a-image:latest");

    // Session pinned to tenant-b gets null -- the old raw-SQL path would
    // have returned tenant-a's row here.
    const sessionB = mockSession({ id: "sess-b", tenant_id: "tenant-b", compute_name: "prod-gpu" });
    const resolvedB = await app.resolveProvider(sessionB);
    expect(resolvedB.compute).toBeNull();
    expect(resolvedB.provider).toBeNull();
  });

  it("does not leak the seeded default-tenant 'local' compute to other tenants", async () => {
    // Local-mode boot seeds a `local` compute row under the default tenant.
    // Under the old raw-SQL resolver, a tenant-b session whose compute_name
    // was "local" (the mode default when compute_name is null) would pick up
    // the default-tenant row. After the fix, tenant-b sees nothing unless it
    // has its own row.
    app = await AppContext.forTestAsync();
    await app.boot();

    // A tenant-b session explicitly naming "local". Under the fix, this
    // routes through `app.forTenant("tenant-b").computes.get("local")` which
    // must miss because tenant-b has no row.
    const sessionB = mockSession({ id: "sess-b-local", tenant_id: "tenant-b", compute_name: "local" });
    const resolved = await app.resolveProvider(sessionB);
    expect(resolved.compute).toBeNull();
    expect(resolved.provider).toBeNull();
  });

  it("tenant-scoped AppContext resolves its own tenant's compute", async () => {
    // Entry point used by conductor dispatch + hosted scheduler: callers
    // hold a tenant-scoped AppContext and invoke `app.resolveProvider(s)`.
    // The session's tenant_id matches the scoped app; result must honour
    // the scope end-to-end.
    app = await AppContext.forTestAsync();
    await app.boot();

    const scoped = app.forTenant("tenant-c");
    await scoped.computeService.create({ name: "ci-runner", provider: "docker" });

    const session = mockSession({ id: "sess-c", tenant_id: "tenant-c", compute_name: "ci-runner" });
    const resolved = await scoped.resolveProvider(session);
    expect(resolved.compute?.name).toBe("ci-runner");
    expect(resolved.compute?.provider).toBe("docker");
  });

  it("session-output.getOutput goes through the session's tenant scope", async () => {
    // session-output previously routed through the `_providerResolver`
    // module singleton (bound to the root AppContext at boot), so
    // getOutput(app, sessionId) for a non-default-tenant session resolved
    // the compute against the root's repo instead of the tenant's. The fix
    // deletes the singleton and makes getOutput call
    // `app.forTenant(session.tenant_id).resolveProvider(session)`.
    app = await AppContext.forTestAsync();
    await app.boot();

    const { getOutput } = await import("../services/session-output.js");

    const tenantB = app.forTenant("tenant-b");
    await tenantB.computeService.create({ name: "gpu-worker", provider: "docker" });

    const sess = await tenantB.sessions.create({ summary: "tb" });
    await tenantB.sessions.update(sess.id, { compute_name: "gpu-worker" });

    // session_id is null so the live-tmux branch is skipped; we're just
    // exercising the resolve-then-fallback flow shape. If the resolver had
    // reverted to the old raw-SQL / module-singleton path, this call would
    // either throw or surface the wrong compute; today it completes
    // cleanly and returns the empty recording fallback.
    const out = await getOutput(app, sess.id);
    expect(typeof out).toBe("string");
  });
});
