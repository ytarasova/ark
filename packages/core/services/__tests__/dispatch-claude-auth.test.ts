/**
 * Integration tests for the tenant-level claude auth materialization path.
 *
 * We stub the k8s Secrets API (so nothing hits a real cluster) and verify:
 *   1. subscription_blob binding + k8s compute -> Secret created, compute
 *      `credsSecretName` patched, session config stashes the secret name.
 *   2. api_key binding -> ANTHROPIC_API_KEY injected into the returned env;
 *      no Secret created.
 *   3. Unbound tenant -> no Secret created, no env contributed.
 *   4. Teardown: deletePerSessionCredsSecret calls deleteNamespacedSecret
 *      idempotently (404 + double-call both fine).
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { AppContext } from "../../app.js";
import { setApp, clearApp } from "../../__tests__/test-helpers.js";
import { TenantClaudeAuthManager } from "../../auth/tenant-claude-auth.js";
import {
  materializeClaudeAuthForDispatch,
  deletePerSessionCredsSecret,
  perSessionSecretName,
  type K8sSecretsApi,
} from "../dispatch-claude-auth.js";

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

/** In-memory k8s Secrets stub that records calls. */
class StubK8sApi implements K8sSecretsApi {
  calls: Array<{ op: string; args: any }> = [];
  secrets = new Map<string, { namespace: string; body: any }>();
  /** Set to 404 / 409 to simulate API errors on the next op. */
  nextError: { op: "create" | "delete"; status: number } | null = null;

  async createNamespacedSecret(args: { namespace: string; body: any }): Promise<unknown> {
    this.calls.push({ op: "create", args });
    if (this.nextError?.op === "create") {
      const e = this.nextError;
      this.nextError = null;
      throw { statusCode: e.status, body: { code: e.status } };
    }
    const key = `${args.namespace}/${args.body?.metadata?.name}`;
    if (this.secrets.has(key)) {
      throw { statusCode: 409, body: { code: 409 } };
    }
    this.secrets.set(key, args);
    return {};
  }

  async deleteNamespacedSecret(args: { name: string; namespace: string }): Promise<unknown> {
    this.calls.push({ op: "delete", args });
    if (this.nextError?.op === "delete") {
      const e = this.nextError;
      this.nextError = null;
      throw { statusCode: e.status, body: { code: e.status } };
    }
    const key = `${args.namespace}/${args.name}`;
    if (!this.secrets.has(key)) {
      throw { statusCode: 404, body: { code: 404 } };
    }
    this.secrets.delete(key);
    return {};
  }
}

async function setupK8sCompute(name = "k8s-target"): Promise<void> {
  await app.computeService.create({
    name,
    compute: "k8s",
    isolation: "direct",
    compute: "k8s",
    isolation: "direct",
    config: { context: "test-ctx", namespace: "ark-test", image: "ark/agent:test" },
    is_template: false,
  });
}

/**
 * Create a session for the default tenant. The materialization code reads
 * `session.tenant_id` and falls back to the config default when null, so
 * for isolation in parallel tests we just vary the binding tenant id and
 * leave the session row with its default.
 */
async function createSession(computeName: string): Promise<{ id: string }> {
  const session = await app.sessions.create({
    summary: "test session",
    flow: "quick",
    compute_name: computeName,
  });
  return session;
}

/** Get the tenant id the dispatch code will use for a default-tenant session. */
function sessionTenantId(): string {
  return app.config.authSection?.defaultTenant ?? "default";
}

describe("materializeClaudeAuthForDispatch", () => {
  it("creates a per-session Secret + patches credsSecretName when tenant is bound to subscription_blob on k8s", async () => {
    await setupK8sCompute("k8s-target");
    const session = await createSession("k8s-target");
    const tenant = sessionTenantId();

    // Seed blob + binding.
    await app.secrets.setBlob(tenant, "claude-subscription", {
      ".credentials.json": '{"apiKey":"sk-abc"}',
      ".claude.json": "{}",
    });
    await new TenantClaudeAuthManager(app.db).set(tenant, "subscription_blob", "claude-subscription");

    const api = new StubK8sApi();
    const fetched = await app.sessions.get(session.id);
    const compute = await app.computes.get("k8s-target");
    const result = await materializeClaudeAuthForDispatch(app, fetched!, compute, {
      k8sApiFactory: async () => api,
    });

    expect(result.credsSecretName).toBe(perSessionSecretName(session.id));
    expect(result.credsSecretNamespace).toBe("ark-test");
    expect(result.env).toEqual({});

    // Secret was created with the right data.
    expect(api.calls.filter((c) => c.op === "create")).toHaveLength(1);
    const createArgs = api.calls[0].args as any;
    expect(createArgs.namespace).toBe("ark-test");
    expect(createArgs.body.metadata.name).toBe(result.credsSecretName);
    expect(createArgs.body.type).toBe("Opaque");
    expect(createArgs.body.metadata.labels["ark.dev/session-creds"]).toBe("true");
    const decoded = Buffer.from(createArgs.body.data[".credentials.json"], "base64").toString();
    expect(decoded).toBe('{"apiKey":"sk-abc"}');

    // Compute config now carries credsSecretName.
    const patchedCompute = await app.computes.get("k8s-target");
    expect((patchedCompute!.config as any).credsSecretName).toBe(result.credsSecretName);

    // Session config stashes the name + namespace for teardown.
    const patchedSession = await app.sessions.get(session.id);
    expect(patchedSession!.config?.creds_secret_name).toBe(result.credsSecretName);
    expect(patchedSession!.config?.creds_secret_namespace).toBe("ark-test");
  });

  it("handles a 409 pre-existing Secret via delete+recreate", async () => {
    await setupK8sCompute("k8s-target");
    const session = await createSession("k8s-target");
    const tenant = sessionTenantId();
    await app.secrets.setBlob(tenant, "claude-sub", { a: "X" });
    await new TenantClaudeAuthManager(app.db).set(tenant, "subscription_blob", "claude-sub");

    const api = new StubK8sApi();
    // Pre-seed the Secret so create returns 409.
    const secretName = perSessionSecretName(session.id);
    api.secrets.set(`ark-test/${secretName}`, { namespace: "ark-test", body: { metadata: { name: secretName } } });

    const fetched = await app.sessions.get(session.id);
    const compute = await app.computes.get("k8s-target");
    const result = await materializeClaudeAuthForDispatch(app, fetched!, compute, {
      k8sApiFactory: async () => api,
    });
    expect(result.credsSecretName).toBe(secretName);
    // Must have issued one create that 409-d, one delete, one create.
    const ops = api.calls.map((c) => c.op);
    expect(ops).toEqual(["create", "delete", "create"]);
  });

  it("injects ANTHROPIC_API_KEY when tenant is bound to api_key", async () => {
    await setupK8sCompute("k8s-target");
    const session = await createSession("k8s-target");
    const tenant = sessionTenantId();
    await app.secrets.set(tenant, "ANTHROPIC_API_KEY", "sk-real");
    await new TenantClaudeAuthManager(app.db).set(tenant, "api_key", "ANTHROPIC_API_KEY");

    const api = new StubK8sApi();
    const fetched = await app.sessions.get(session.id);
    const compute = await app.computes.get("k8s-target");
    const result = await materializeClaudeAuthForDispatch(app, fetched!, compute, {
      k8sApiFactory: async () => api,
    });
    expect(result.env.ANTHROPIC_API_KEY).toBe("sk-real");
    expect(result.credsSecretName).toBeNull();
    expect(api.calls).toHaveLength(0);
  });

  it("is a no-op when the tenant has no binding", async () => {
    await setupK8sCompute("k8s-target");
    const session = await createSession("k8s-target");
    const api = new StubK8sApi();
    const fetched = await app.sessions.get(session.id);
    const compute = await app.computes.get("k8s-target");
    const result = await materializeClaudeAuthForDispatch(app, fetched!, compute, {
      k8sApiFactory: async () => api,
    });
    expect(result.env).toEqual({});
    expect(result.credsSecretName).toBeNull();
    expect(api.calls).toHaveLength(0);
    // Compute config untouched.
    const cfg = (await app.computes.get("k8s-target"))!.config as any;
    expect(cfg.credsSecretName).toBeUndefined();
  });

  it("skips Secret creation on non-k8s compute even when blob is bound", async () => {
    await app.computeService.create({
      name: "docker-target",
      compute: "local",
      isolation: "docker",
      compute: "local",
      isolation: "docker",
      config: {},
    });
    const session = await createSession("docker-target");
    const tenant = sessionTenantId();
    await app.secrets.setBlob(tenant, "claude-sub", { a: "X" });
    await new TenantClaudeAuthManager(app.db).set(tenant, "subscription_blob", "claude-sub");
    const api = new StubK8sApi();
    const fetched = await app.sessions.get(session.id);
    const compute = await app.computes.get("docker-target");
    const result = await materializeClaudeAuthForDispatch(app, fetched!, compute, {
      k8sApiFactory: async () => api,
    });
    expect(result.credsSecretName).toBeNull();
    expect(api.calls).toHaveLength(0);
  });

  // Regression: the old dispatch path name-gated on `provider === "k8s" ||
  // "k8s-kata"`. A new k8s-family provider (e.g. a future "k8s-eks" adapter)
  // would be silently skipped. With the capability flag in place, any
  // provider that declares `supportsSecretMount: true` gets the Secret
  // mount -- regardless of its name.
  it("mounts a Secret on a new k8s-family provider that declares supportsSecretMount=true", async () => {
    // Register a minimal stub provider named "k8s-eks" that reports
    // supportsSecretMount=true but is NOT one of the hardcoded names.
    class K8sEksStubProvider {
      readonly name = "k8s-eks";
      readonly isolationModes = [];
      readonly singleton = false;
      readonly canReboot = false;
      readonly canDelete = true;
      readonly supportsWorktree = false;
      readonly initialStatus = "stopped";
      readonly needsAuth = false;
      readonly supportsSecretMount = true;
      setApp(): void {}
      async provision(): Promise<void> {}
      async destroy(): Promise<void> {}
      async start(): Promise<void> {}
      async stop(): Promise<void> {}
      async launch(): Promise<string> {
        return "";
      }
      async attach(): Promise<void> {}
      async killAgent(): Promise<void> {}
      async captureOutput(): Promise<string> {
        return "";
      }
      async cleanupSession(): Promise<void> {}
      async getMetrics(): Promise<any> {
        return {};
      }
      async probePorts(): Promise<any[]> {
        return [];
      }
      async syncEnvironment(): Promise<void> {}
      async checkSession(): Promise<boolean> {
        return true;
      }
      getAttachCommand(): string[] {
        return [];
      }
      buildChannelConfig(): Record<string, unknown> {
        return {};
      }
      buildLaunchEnv(): Record<string, string> {
        return {};
      }
    }
    app.registerProvider(new K8sEksStubProvider() as any);
    // Insert a compute row that points at the k8s-eks provider.
    await app.computes.insert({
      name: "eks-target",
      provider: "k8s-eks" as any,
      compute_kind: "k8s",
      isolation_kind: "direct",
      status: "running",
      config: { namespace: "ark-eks" },
    } as any);

    const session = await createSession("eks-target");
    const tenant = sessionTenantId();
    await app.secrets.setBlob(tenant, "claude-sub", { a: "X" });
    await new TenantClaudeAuthManager(app.db).set(tenant, "subscription_blob", "claude-sub");

    const api = new StubK8sApi();
    const fetched = await app.sessions.get(session.id);
    const compute = await app.computes.get("eks-target");
    const result = await materializeClaudeAuthForDispatch(app, fetched!, compute, {
      k8sApiFactory: async () => api,
    });

    // Secret WAS mounted for the new capability-declaring provider.
    expect(result.credsSecretName).toBe(perSessionSecretName(session.id));
    expect(result.credsSecretNamespace).toBe("ark-eks");
    expect(api.calls.filter((c) => c.op === "create")).toHaveLength(1);
  });

  it("skips Secret creation on a provider that declares supportsSecretMount=false", async () => {
    // A second stub provider identical to the first except for the flag.
    class NoMountProvider {
      readonly name = "custom-no-mount";
      readonly isolationModes = [];
      readonly singleton = false;
      readonly canReboot = false;
      readonly canDelete = true;
      readonly supportsWorktree = false;
      readonly initialStatus = "stopped";
      readonly needsAuth = false;
      readonly supportsSecretMount = false;
      setApp(): void {}
      async provision(): Promise<void> {}
      async destroy(): Promise<void> {}
      async start(): Promise<void> {}
      async stop(): Promise<void> {}
      async launch(): Promise<string> {
        return "";
      }
      async attach(): Promise<void> {}
      async killAgent(): Promise<void> {}
      async captureOutput(): Promise<string> {
        return "";
      }
      async cleanupSession(): Promise<void> {}
      async getMetrics(): Promise<any> {
        return {};
      }
      async probePorts(): Promise<any[]> {
        return [];
      }
      async syncEnvironment(): Promise<void> {}
      async checkSession(): Promise<boolean> {
        return true;
      }
      getAttachCommand(): string[] {
        return [];
      }
      buildChannelConfig(): Record<string, unknown> {
        return {};
      }
      buildLaunchEnv(): Record<string, string> {
        return {};
      }
    }
    app.registerProvider(new NoMountProvider() as any);
    await app.computes.insert({
      name: "no-mount-target",
      provider: "custom-no-mount" as any,
      compute_kind: "local",
      isolation_kind: "direct",
      status: "running",
      config: {},
    } as any);

    const session = await createSession("no-mount-target");
    const tenant = sessionTenantId();
    await app.secrets.setBlob(tenant, "claude-sub", { a: "X" });
    await new TenantClaudeAuthManager(app.db).set(tenant, "subscription_blob", "claude-sub");

    const api = new StubK8sApi();
    const fetched = await app.sessions.get(session.id);
    const compute = await app.computes.get("no-mount-target");
    const result = await materializeClaudeAuthForDispatch(app, fetched!, compute, {
      k8sApiFactory: async () => api,
    });

    expect(result.credsSecretName).toBeNull();
    expect(api.calls).toHaveLength(0);
  });
});

describe("deletePerSessionCredsSecret", () => {
  it("deletes the Secret and clears session config stash", async () => {
    await setupK8sCompute("k8s-target");
    const session = await createSession("k8s-target");
    const tenant = sessionTenantId();
    await app.secrets.setBlob(tenant, "claude-sub", { a: "X" });
    await new TenantClaudeAuthManager(app.db).set(tenant, "subscription_blob", "claude-sub");

    const api = new StubK8sApi();
    const fetched = await app.sessions.get(session.id);
    const compute = await app.computes.get("k8s-target");
    await materializeClaudeAuthForDispatch(app, fetched!, compute, { k8sApiFactory: async () => api });

    const refetched = await app.sessions.get(session.id);
    await deletePerSessionCredsSecret(app, refetched!, compute, { k8sApiFactory: async () => api });
    expect(api.calls.filter((c) => c.op === "delete")).toHaveLength(1);

    const afterTeardown = await app.sessions.get(session.id);
    expect(afterTeardown!.config?.creds_secret_name ?? null).toBeNull();
  });

  it("is idempotent when the Secret is already gone (404)", async () => {
    await setupK8sCompute("k8s-target");
    const session = await createSession("k8s-target");
    // Hand-stash the secret name without actually creating the Secret.
    await app.sessions.mergeConfig(session.id, {
      creds_secret_name: "ark-creds-missing",
      creds_secret_namespace: "ark-test",
    });
    const fetched = await app.sessions.get(session.id);
    const compute = await app.computes.get("k8s-target");
    const api = new StubK8sApi();
    // Should not throw.
    await deletePerSessionCredsSecret(app, fetched!, compute, { k8sApiFactory: async () => api });
    // Still cleared the stash.
    const after = await app.sessions.get(session.id);
    expect(after!.config?.creds_secret_name ?? null).toBeNull();
  });

  it("no-ops when no creds secret was stashed", async () => {
    await setupK8sCompute("k8s-target");
    const session = await createSession("k8s-target");
    const api = new StubK8sApi();
    const fetched = await app.sessions.get(session.id);
    const compute = await app.computes.get("k8s-target");
    await deletePerSessionCredsSecret(app, fetched!, compute, { k8sApiFactory: async () => api });
    expect(api.calls).toHaveLength(0);
  });
});
