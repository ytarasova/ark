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
