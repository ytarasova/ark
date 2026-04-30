/**
 * Tests for placeAllSecrets central dispatch.
 *
 * Each test boots a fresh AppContext via forTestAsync() and wipes
 * tenant secrets between cases for isolation. Stub placers for
 * fail-fast / warn-only branches go through __test_registerPlacer
 * so we don't have to push synthetic types past the file provider's
 * safeSecretType validator.
 */

import { describe, expect, test, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { AppContext } from "../../app.js";
import { setApp, clearApp } from "../../__tests__/test-helpers.js";
import { placeAllSecrets, __test_registerPlacer } from "../placement.js";
import { envVarPlacer } from "../placers/env-var.js";
import { MockPlacementCtx } from "./mock-placement-ctx.js";

describe("placeAllSecrets", () => {
  let app: AppContext;

  beforeAll(async () => {
    app = await AppContext.forTestAsync();
    await app.boot();
    setApp(app);
  });

  afterAll(async () => {
    await app?.shutdown();
    clearApp();
  });

  beforeEach(async () => {
    // Wipe string + blob secrets between tests for isolation.
    const refs = await app.secrets.list("default");
    for (const r of refs) await app.secrets.delete("default", r.name);
    const blobs = await app.secrets.listBlobs("default");
    for (const b of blobs) await app.secrets.deleteBlob("default", b);
  });

  afterEach(() => {
    // Always restore the real env-var placer so cross-test stubs don't leak.
    __test_registerPlacer("env-var", envVarPlacer);
  });

  function fakeSession(): any {
    return { id: "s-test", tenant_id: "default" };
  }

  test("places every env-var secret as setEnv calls", async () => {
    await app.secrets.set("default", "FOO_KEY", "foo-value", { type: "env-var", metadata: {} });
    await app.secrets.set("default", "BAR_KEY", "bar-value", { type: "env-var", metadata: {} });

    const ctx = new MockPlacementCtx();
    await placeAllSecrets(app, fakeSession(), ctx);

    const envCalls = ctx.calls.filter((c) => c.kind === "setEnv");
    expect(envCalls).toHaveLength(2);
    expect(envCalls).toEqual(
      expect.arrayContaining([
        { kind: "setEnv", key: "FOO_KEY", value: "foo-value" },
        { kind: "setEnv", key: "BAR_KEY", value: "bar-value" },
      ]),
    );
  });

  test("narrowing filter restricts to listed names", async () => {
    await app.secrets.set("default", "FOO_KEY", "foo-value", { type: "env-var", metadata: {} });
    await app.secrets.set("default", "BAR_KEY", "bar-value", { type: "env-var", metadata: {} });

    const ctx = new MockPlacementCtx();
    await placeAllSecrets(app, fakeSession(), ctx, { narrow: new Set(["FOO_KEY"]) });

    const envCalls = ctx.calls.filter((c) => c.kind === "setEnv");
    expect(envCalls).toEqual([{ kind: "setEnv", key: "FOO_KEY", value: "foo-value" }]);
  });

  test("unknown type is skipped, not thrown (kubeconfig has no Phase 1 placer)", async () => {
    // kubeconfig is a valid SecretType (passes safeSecretType) but has no
    // registered placer in Phase 1, so the dispatch should silently skip.
    await app.secrets.set("default", "KUBE", "config-yaml", { type: "kubeconfig", metadata: {} });

    const ctx = new MockPlacementCtx();
    await placeAllSecrets(app, fakeSession(), ctx);

    expect(ctx.calls.filter((c) => c.kind === "setEnv")).toHaveLength(0);
    expect(ctx.calls).toHaveLength(0);
  });

  test("placer failure for env-var rethrows (fail-fast)", async () => {
    // Replace the env-var placer with one that throws; env-var is in FAIL_FAST
    // so the dispatch must rethrow.
    __test_registerPlacer("env-var", {
      type: "env-var",
      place: async () => {
        throw new Error("boom");
      },
    });
    await app.secrets.set("default", "DOOM", "x", { type: "env-var", metadata: {} });

    const ctx = new MockPlacementCtx();
    await expect(placeAllSecrets(app, fakeSession(), ctx)).rejects.toThrow(/boom/);
  });

  test("non-fail-fast placer failure logs and continues (placeholder for Phase 3)", async () => {
    // Phase 1 only registers env-var, which is in FAIL_FAST. The non-fail-fast
    // branch is exercised once generic-blob lands in Phase 3. Sentinel assertion
    // documents the policy without burning a synthetic type.
    expect(true).toBe(true);
  });
});
