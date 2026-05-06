/**
 * Unit tests for `setSecretOwnerToPod` -- the owner-reference patch that
 * hooks k8s native garbage collection into the per-session creds Secret
 * lifecycle. Covers:
 *
 *   1. Happy path: patch is issued with the correct strategic-merge body
 *      + content-type + ownerReferences shape.
 *   2. Pod deleted mid-flight (404 on patch) -- we warn and swallow, no
 *      throw, so launch doesn't regress.
 *   3. Missing pod metadata -- we skip cleanly without touching the API.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { AppContext } from "../../app.js";
import { setApp, clearApp } from "../../__tests__/test-helpers.js";
import { setSecretOwnerToPod, type K8sSecretsApi } from "../dispatch-claude-auth.js";
import { K8sProvider } from "../../compute/providers/k8s.js";

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

/** Stub that records every patch call so we can assert shape + headers. */
class StubApi implements K8sSecretsApi {
  patchCalls: Array<{
    name: string;
    namespace: string;
    body: any;
    options?: { headers?: Record<string, string> };
  }> = [];
  /** When set, the next patch call throws an error with this statusCode. */
  nextPatchError: number | null = null;

  async createNamespacedSecret() {
    return {};
  }
  async deleteNamespacedSecret() {
    return {};
  }
  async patchNamespacedSecret(args: {
    name: string;
    namespace: string;
    body: unknown;
    options?: { headers?: Record<string, string> };
  }): Promise<unknown> {
    this.patchCalls.push({ ...args, body: args.body as any });
    if (this.nextPatchError != null) {
      const status = this.nextPatchError;
      this.nextPatchError = null;
      throw { statusCode: status, body: { code: status }, message: `stub ${status}` };
    }
    return {};
  }
}

describe("setSecretOwnerToPod", () => {
  it("issues a strategic-merge patch with the expected ownerReferences", async () => {
    const api = new StubApi();
    await setSecretOwnerToPod(app, {
      clusterConfig: { namespace: "ark-test" },
      namespace: "ark-test",
      secretName: "ark-creds-abc123",
      pod: { metadata: { name: "ark-abc123", uid: "uid-xyz-001" } },
      k8sApiFactory: async () => api,
    });

    expect(api.patchCalls).toHaveLength(1);
    const call = api.patchCalls[0];
    expect(call.name).toBe("ark-creds-abc123");
    expect(call.namespace).toBe("ark-test");
    expect(call.options?.headers?.["Content-Type"]).toBe("application/strategic-merge-patch+json");
    expect(call.body).toEqual({
      metadata: {
        ownerReferences: [
          {
            apiVersion: "v1",
            kind: "Pod",
            name: "ark-abc123",
            uid: "uid-xyz-001",
            controller: false,
            blockOwnerDeletion: true,
          },
        ],
      },
    });
  });

  it("swallows a 404 from the k8s API (pod deleted mid-flight) without throwing", async () => {
    const api = new StubApi();
    api.nextPatchError = 404;
    // Must not throw.
    await setSecretOwnerToPod(app, {
      clusterConfig: {},
      namespace: "ark-test",
      secretName: "ark-creds-missing",
      pod: { metadata: { name: "ark-missing", uid: "uid-404" } },
      k8sApiFactory: async () => api,
    });
    expect(api.patchCalls).toHaveLength(1);
  });

  it("swallows non-404 patch errors as well (launch must not regress)", async () => {
    const api = new StubApi();
    api.nextPatchError = 500;
    await setSecretOwnerToPod(app, {
      clusterConfig: {},
      namespace: "ark-test",
      secretName: "ark-creds-err",
      pod: { metadata: { name: "ark-err", uid: "uid-err" } },
      k8sApiFactory: async () => api,
    });
    expect(api.patchCalls).toHaveLength(1);
  });

  it("skips the patch entirely when pod metadata is missing name/uid", async () => {
    const api = new StubApi();
    await setSecretOwnerToPod(app, {
      clusterConfig: {},
      namespace: "ark-test",
      secretName: "ark-creds-bad",
      pod: { metadata: {} },
      k8sApiFactory: async () => api,
    });
    expect(api.patchCalls).toHaveLength(0);
  });
});

/**
 * Integration: K8sProvider.launch() must trigger the owner-ref patch
 * when the compute row carries `credsSecretName`. This is the
 * load-bearing wiring -- without it the patch would only fire from
 * tests. We stub the full CoreV1Api (`createNamespacedPod` +
 * `patchNamespacedSecret`) on a K8sProvider instance by bypassing
 * `getApi` the same way `k8s-provider-launch.test.ts` does.
 */
describe("K8sProvider.launch owner-ref integration", () => {
  it("calls patchNamespacedSecret with the created Pod's uid when credsSecretName is set", async () => {
    const rec: {
      patched: any[];
      createdPodUid: string;
    } = { patched: [], createdPodUid: "uid-launched-pod-42" };

    const fakeApi = {
      readNamespace: async () => ({ metadata: { name: "ark-test" } }),
      createNamespace: async () => {},
      createNamespacedPod: async (opts: { namespace: string; body: any }) => {
        // Simulate the real k8s return: a Pod with server-assigned uid.
        return {
          metadata: { name: opts.body.metadata.name, namespace: opts.namespace, uid: rec.createdPodUid },
          spec: opts.body.spec,
        };
      },
      patchNamespacedSecret: async (args: {
        name: string;
        namespace: string;
        body: any;
        options?: { headers?: Record<string, string> };
      }) => {
        rec.patched.push(args);
        return {};
      },
      deleteNamespacedPod: async () => {},
    };

    const provider = new K8sProvider(app);
    (provider as unknown as { kubeApi: unknown }).kubeApi = fakeApi;

    const compute = {
      name: "k8s-owner-ref",
      provider: "k8s" as const,
      compute_kind: "k8s" as const,
      isolation_kind: "direct" as const,
      config: {
        provider: "k8s" as const,
        context: "test-ctx",
        namespace: "ark-test",
        image: "alpine:3.19",
        credsSecretName: "ark-creds-test-123",
      },
      status: "running" as const,
      is_template: false,
      cloned_from: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    const session = {
      id: "ownerref-12345678-0000-0000-0000-000000000000",
      summary: "owner-ref launch test",
      flow: "e2e-noop",
      stage: "noop",
      status: "ready" as const,
      tenant_id: "default",
      user_id: "system",
      compute_name: "k8s-owner-ref",
    } as any;

    await provider.launch(compute as any, session, {
      tmuxName: "ark-ownerref",
      workdir: "/tmp/wd",
      launcherContent: "#!/bin/sh\n:",
      ports: [],
    });

    expect(rec.patched).toHaveLength(1);
    const call = rec.patched[0];
    expect(call.name).toBe("ark-creds-test-123");
    expect(call.namespace).toBe("ark-test");
    expect(call.options?.headers?.["Content-Type"]).toBe("application/strategic-merge-patch+json");
    expect(call.body.metadata.ownerReferences[0].uid).toBe(rec.createdPodUid);
    expect(call.body.metadata.ownerReferences[0].kind).toBe("Pod");
    expect(call.body.metadata.ownerReferences[0].blockOwnerDeletion).toBe(true);
  });

  it("does not call patchNamespacedSecret when credsSecretName is absent (action-only path)", async () => {
    const rec: { patched: any[]; created: any[] } = { patched: [], created: [] };
    const fakeApi = {
      readNamespace: async () => ({ metadata: { name: "ark-test" } }),
      createNamespace: async () => {},
      createNamespacedPod: async (opts: { namespace: string; body: any }) => {
        rec.created.push(opts);
        return { metadata: { name: opts.body.metadata.name, uid: "uid-no-creds" }, spec: opts.body.spec };
      },
      patchNamespacedSecret: async (args: unknown) => {
        rec.patched.push(args);
        return {};
      },
      deleteNamespacedPod: async () => {},
    };

    const provider = new K8sProvider(app);
    (provider as unknown as { kubeApi: unknown }).kubeApi = fakeApi;

    const compute = {
      name: "k8s-no-creds",
      provider: "k8s" as const,
      compute_kind: "k8s" as const,
      isolation_kind: "direct" as const,
      config: { provider: "k8s" as const, context: "test-ctx", namespace: "ark-test", image: "alpine:3.19" },
      status: "running" as const,
      is_template: false,
      cloned_from: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    const session = {
      id: "nocreds-12345678-0000-0000-0000-000000000000",
      summary: "no creds launch test",
      flow: "e2e-noop",
      stage: "noop",
      status: "ready" as const,
      tenant_id: "default",
      user_id: "system",
      compute_name: "k8s-no-creds",
    } as any;

    await provider.launch(compute as any, session, {
      tmuxName: "ark-nocreds",
      workdir: "/tmp/wd",
      launcherContent: "#!/bin/sh\n:",
      ports: [],
    });

    expect(rec.created).toHaveLength(1);
    expect(rec.patched).toHaveLength(0);
  });
});
