/**
 * Tests for the placeAllSecrets wiring inside buildLaunchEnv.
 *
 * Phase 1: placement is *additive*. A provider opts in by implementing
 * `buildPlacementCtx`. When it does, placeAllSecrets runs against the tenant's
 * secrets, the placer mutates the ctx, and ctx.getEnv() is merged into the
 * launch env. When the provider does NOT implement buildPlacementCtx (the
 * common case in Phase 1, since no concrete provider has a real impl yet), the
 * branch is dead and the legacy claude-auth + stage/runtime secrets-resolve
 * paths still drive the launch env.
 *
 * Both paths are exercised here so the regression net catches a future change
 * that disconnects the wiring.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { AppContext } from "../../app.js";
import { setApp, clearApp } from "../../__tests__/test-helpers.js";
import { buildLaunchEnv } from "../dispatch/launch.js";
import { StageSecretResolver } from "../dispatch/secrets-resolve.js";
import type { PlacementCtx } from "../../secrets/placement-types.js";
import { MockPlacementCtx } from "../../secrets/__tests__/mock-placement-ctx.js";
import { DeferredPlacementCtx } from "../../secrets/deferred-placement-ctx.js";
import { __test_registerPlacer } from "../../secrets/placement.js";
import { envVarPlacer } from "../../secrets/placers/env-var.js";
import type { TypedSecretPlacer } from "../../secrets/placement-types.js";
import type { ComputeProvider } from "../../compute/types.js";
import type { Compute, Session } from "../../../types/index.js";

let app: AppContext;

beforeEach(async () => {
  app = await AppContext.forTestAsync();
  await app.boot();
  setApp(app);
});
afterEach(async () => {
  await app?.shutdown();
  clearApp();
});

/**
 * Minimal stub `ComputeProvider` covering only the surface buildLaunchEnv
 * touches: name, capability flags, and (optionally) buildPlacementCtx. The
 * other methods are no-ops because launch-env assembly does not call them.
 */
function makeStubProvider(opts: {
  name: string;
  ctx?: PlacementCtx;
  buildCtx?: (session: Session, compute: Compute) => Promise<PlacementCtx>;
}): ComputeProvider {
  const provider: any = {
    name: opts.name,
    isolationModes: [],
    singleton: false,
    canReboot: false,
    canDelete: true,
    supportsWorktree: false,
    initialStatus: "stopped",
    needsAuth: false,
    supportsSecretMount: false,
    setApp() {},
    async provision() {},
    async destroy() {},
    async start() {},
    async stop() {},
    async launch() {
      return "";
    },
    async attach() {},
    async killAgent() {},
    async captureOutput() {
      return "";
    },
    async cleanupSession() {},
    async getMetrics() {
      return {};
    },
    async probePorts() {
      return [];
    },
    async syncEnvironment() {},
    async checkSession() {
      return true;
    },
    getAttachCommand() {
      return [];
    },
    buildChannelConfig() {
      return {};
    },
    buildLaunchEnv() {
      return {};
    },
  };
  if (opts.buildCtx || opts.ctx) {
    provider.buildPlacementCtx = opts.buildCtx ?? (async () => opts.ctx as PlacementCtx);
  }
  return provider as ComputeProvider;
}

/** Tenant id the dispatch path uses for sessions with a null tenant_id. */
function tenant(): string {
  return app.config.authSection?.defaultTenant ?? "default";
}

/**
 * Build the `Pick<DispatchDeps, ...>` shape buildLaunchEnv expects, with a
 * no-op materializeClaudeAuth (so the test isolates the placement branch).
 */
function makeDeps(): Parameters<typeof buildLaunchEnv>[0] {
  return {
    computes: app.computes,
    runtimes: app.runtimes,
    materializeClaudeAuth: async () => ({ env: {}, credsSecretName: null, credsSecretNamespace: null }),
    getApp: () => app,
  };
}

describe("buildLaunchEnv with placeAllSecrets wiring", () => {
  it("runs placement and merges ctx.getEnv() when the provider implements buildPlacementCtx", async () => {
    // Override the registered "local" provider with a stub that exposes
    // buildPlacementCtx. providerOf({compute_kind:"local", isolation_kind:"direct"})
    // returns "local", so the lookup inside buildLaunchEnv lands on us.
    const ctx = new MockPlacementCtx();
    const provider = makeStubProvider({
      name: "local",
      buildCtx: async () => ctx,
    });
    app.registerProvider(provider);
    await app.computes.insert({
      name: "stub-target",
      provider: "local",
      compute_kind: "local",
      isolation_kind: "direct",
      status: "running",
      config: {},
    } as any);

    // Tenant has one env-var secret. Placement should run env-var placer
    // against the MockPlacementCtx and we should see it land on the launch env.
    await app.secrets.set(tenant(), "STUB_TOKEN", "stub-value", { type: "env-var", metadata: {} });

    const session = await app.sessions.create({
      summary: "test session",
      flow: "quick",
      compute_name: "stub-target",
    });
    const fetched = (await app.sessions.get(session.id))!;

    // No stage / runtime secrets declared -> narrow is undefined -> auto-attach
    // every tenant secret. STUB_TOKEN is the only one.
    const deps = makeDeps();
    const secrets = new StageSecretResolver({
      runtimes: app.runtimes,
      secrets: app.secrets,
      config: app.config,
    });
    const result = await buildLaunchEnv(deps, secrets, fetched, null, "test-only-runtime", () => {});

    expect(result.error).toBeUndefined();
    expect(result.env.STUB_TOKEN).toBe("stub-value");
    // The MockPlacementCtx recorded a setEnv call -- proving placement actually ran.
    expect(ctx.calls.some((c) => c.kind === "setEnv" && c.key === "STUB_TOKEN")).toBe(true);
  });

  it("skips placement when the provider does not implement buildPlacementCtx", async () => {
    // Same setup as above, but the provider does NOT expose buildPlacementCtx.
    // Override "local" with a stub missing the optional method.
    const provider = makeStubProvider({ name: "local" });
    app.registerProvider(provider);
    await app.computes.insert({
      name: "noctx-target",
      provider: "local",
      compute_kind: "local",
      isolation_kind: "direct",
      status: "running",
      config: {},
    } as any);

    await app.secrets.set(tenant(), "STUB_TOKEN", "stub-value", { type: "env-var", metadata: {} });

    const session = await app.sessions.create({
      summary: "test session",
      flow: "quick",
      compute_name: "noctx-target",
    });
    const fetched = (await app.sessions.get(session.id))!;

    const deps = makeDeps();
    const secrets = new StageSecretResolver({
      runtimes: app.runtimes,
      secrets: app.secrets,
      config: app.config,
    });
    const result = await buildLaunchEnv(deps, secrets, fetched, null, "test-only-runtime", () => {});

    expect(result.error).toBeUndefined();
    // Legacy stage/runtime resolve also did not match (no stage, no runtime
    // declared the secret), so STUB_TOKEN must be absent. Proves placement
    // really was skipped instead of silently running through a fallback.
    expect(result.env.STUB_TOKEN).toBeUndefined();
  });

  it("narrowing filter is the union of stage.secrets and runtime.secrets", async () => {
    // Two tenant secrets; we declare only one on the stage so the narrow filter
    // restricts placement to that name.
    await app.secrets.set(tenant(), "WANTED", "yes", { type: "env-var", metadata: {} });
    await app.secrets.set(tenant(), "EXTRA", "no", { type: "env-var", metadata: {} });

    const ctx = new MockPlacementCtx();
    app.registerProvider(makeStubProvider({ name: "local", buildCtx: async () => ctx }));
    await app.computes.insert({
      name: "narrow-target",
      provider: "local",
      compute_kind: "local",
      isolation_kind: "direct",
      status: "running",
      config: {},
    } as any);

    const session = await app.sessions.create({
      summary: "test session",
      flow: "quick",
      compute_name: "narrow-target",
    });
    const fetched = (await app.sessions.get(session.id))!;

    const stageDef = { name: "stage-x", secrets: ["WANTED"] } as any;
    const deps = makeDeps();
    const secrets = new StageSecretResolver({
      runtimes: app.runtimes,
      secrets: app.secrets,
      config: app.config,
    });
    const result = await buildLaunchEnv(deps, secrets, fetched, stageDef, "test-only-runtime", () => {});

    expect(result.error).toBeUndefined();
    // WANTED resolved + placed; EXTRA filtered out by narrow.
    expect(result.env.WANTED).toBe("yes");
    expect(result.env.EXTRA).toBeUndefined();
    expect(ctx.calls.filter((c) => c.kind === "setEnv").map((c: any) => c.key)).toEqual(["WANTED"]);
  });

  it("returns the placement ctx so dispatch can forward it to provider.launch", async () => {
    // The dispatcher needs a handle on the ctx so it can pipe a deferred
    // ctx through to provider.launch (where remote-medium providers flush
    // queued file ops once the instance is reachable). buildLaunchEnv
    // exposes it as `result.placement`.
    const ctx = new MockPlacementCtx();
    app.registerProvider(makeStubProvider({ name: "local", buildCtx: async () => ctx }));
    await app.computes.insert({
      name: "echo-target",
      provider: "local",
      compute_kind: "local",
      isolation_kind: "direct",
      status: "running",
      config: {},
    } as any);

    const session = await app.sessions.create({
      summary: "s",
      flow: "quick",
      compute_name: "echo-target",
    });
    const fetched = (await app.sessions.get(session.id))!;

    const deps = makeDeps();
    const secrets = new StageSecretResolver({
      runtimes: app.runtimes,
      secrets: app.secrets,
      config: app.config,
    });
    const result = await buildLaunchEnv(deps, secrets, fetched, null, "test-only-runtime", () => {});
    expect(result.placement).toBe(ctx);
  });

  it("file-typed secrets are deferred (queued, not executed) when the ctx is a DeferredPlacementCtx", async () => {
    // The EC2 path now hands buildLaunchEnv a DeferredPlacementCtx because
    // the SSH medium isn't ready pre-launch. Register a stub placer that
    // both writes a file AND sets an env var; assert the env lands on the
    // launch env synchronously while the file op is queued for post-flush.
    const stubPlacer: TypedSecretPlacer = {
      type: "env-var",
      async place(secret, place) {
        // Pretend this is a multi-effect secret: env + file. We key the
        // file path off `secret.name` so the assertion can find OUR
        // op even when other seeded runtime secrets (added by
        // installTestSecrets in the test profile) ride through the
        // same stub.
        place.setEnv(secret.name, secret.value!);
        await place.writeFile(`/home/ubuntu/.${secret.name}.token`, 0o600, new TextEncoder().encode(secret.value!));
      },
    };
    __test_registerPlacer("env-var", stubPlacer);
    // Restore the production env-var placer after this case so we don't
    // leak the multi-effect stub into other tests / files that share the
    // module-level placer registry.
    try {
      const ctx = new DeferredPlacementCtx();
      app.registerProvider(makeStubProvider({ name: "local", buildCtx: async () => ctx }));
      await app.computes.insert({
        name: "deferred-target",
        provider: "local",
        compute_kind: "local",
        isolation_kind: "direct",
        status: "running",
        config: {},
      } as any);

      await app.secrets.set(tenant(), "DEFER_TOKEN", "secret-val", { type: "env-var", metadata: {} });

      const session = await app.sessions.create({
        summary: "s",
        flow: "quick",
        compute_name: "deferred-target",
      });
      const fetched = (await app.sessions.get(session.id))!;

      const deps = makeDeps();
      const secrets = new StageSecretResolver({
        runtimes: app.runtimes,
        secrets: app.secrets,
        config: app.config,
      });
      const result = await buildLaunchEnv(deps, secrets, fetched, null, "test-only-runtime", () => {});

      expect(result.error).toBeUndefined();
      // Env was captured synchronously and merged into the launch env.
      expect(result.env.DEFER_TOKEN).toBe("secret-val");
      // The file write for DEFER_TOKEN was DEFERRED, not executed.
      // The test profile pre-seeds dummy values for every runtime-
      // declared secret (CLAUDE_CODE_OAUTH_TOKEN, ANTHROPIC_API_KEY, ...);
      // they all ride through the same stub and produce their own
      // writeFile ops. Find ours by name.
      expect(ctx.hasDeferred()).toBe(true);
      const deferOp = ctx.queuedOps.find(
        (op) => op.kind === "writeFile" && op.path === "/home/ubuntu/.DEFER_TOKEN.token",
      );
      expect(deferOp).toBeDefined();

      // The placement ctx is also returned via result.placement so the
      // dispatcher can pipe it to provider.launch for post-provision flush.
      expect(result.placement).toBe(ctx);
    } finally {
      __test_registerPlacer("env-var", envVarPlacer);
    }
  });

  it("returns an error and does not launch when a fail-fast placer throws", async () => {
    // Make the stub ctx blow up on setEnv -- env-var is in FAIL_FAST so the
    // dispatch must fail closed rather than launching with an incomplete env.
    const failingCtx: PlacementCtx = {
      async writeFile() {},
      async appendFile() {},
      setEnv() {
        throw new Error("simulated placement failure");
      },
      setProvisionerConfig() {},
      expandHome(rel: string) {
        return rel;
      },
      getEnv() {
        return {};
      },
    };
    app.registerProvider(makeStubProvider({ name: "local", buildCtx: async () => failingCtx }));
    await app.computes.insert({
      name: "fail-target",
      provider: "local",
      compute_kind: "local",
      isolation_kind: "direct",
      status: "running",
      config: {},
    } as any);
    await app.secrets.set(tenant(), "BOOM", "x", { type: "env-var", metadata: {} });

    const session = await app.sessions.create({
      summary: "test session",
      flow: "quick",
      compute_name: "fail-target",
    });
    const fetched = (await app.sessions.get(session.id))!;

    const deps = makeDeps();
    const secrets = new StageSecretResolver({
      runtimes: app.runtimes,
      secrets: app.secrets,
      config: app.config,
    });
    const result = await buildLaunchEnv(deps, secrets, fetched, null, "test-only-runtime", () => {});

    expect(result.error).toBeDefined();
    expect(result.error).toMatch(/placement/i);
  });
});
