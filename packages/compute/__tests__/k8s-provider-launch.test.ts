/**
 * K8sProvider.launch / start regression tests.
 *
 * Historically the provider spawned session pods with `command: ["/bin/bash",
 * "-c", opts.launcherContent]`. That wedges on alpine (no bash), and -- more
 * importantly -- every running pod turned into a zombie exec failure the
 * instant a user pointed their k8s compute at a slim base image. POSIX `sh`
 * is guaranteed on every container image we care about, so the container
 * entry point now shells out through `/bin/sh -c` and delegates bashism
 * handling to the launcher script's own shebang (which is what the rest of
 * the launcher pipeline assumes anyway).
 *
 * These tests are pure unit tests -- they swap the k8s SDK import inside
 * `K8sProvider` for a stub that records every pod body it sees, so no real
 * cluster is required. If the launcher command ever drifts back to
 * `/bin/bash`, these tests will fail and the CI regression will be visible.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";

import { K8sProvider } from "../providers/k8s.js";
import { AppContext } from "../../core/app.js";
import { setApp, clearApp } from "../../core/__tests__/test-helpers.js";

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

interface Recorded {
  lastPod: Record<string, any> | null;
  calls: string[];
}

function fakeApi(rec: Recorded) {
  return {
    readNamespace: async (_opts: { name: string }) => {
      rec.calls.push("readNamespace");
      return { metadata: { name: "ark" } };
    },
    createNamespace: async (_opts: { body: unknown }) => {
      rec.calls.push("createNamespace");
    },
    createNamespacedPod: async (opts: { namespace: string; body: any }) => {
      rec.calls.push("createNamespacedPod");
      rec.lastPod = opts.body;
    },
    readNamespacedPod: async () => {
      rec.calls.push("readNamespacedPod");
      throw new Error("not found");
    },
    deleteNamespacedPod: async () => {
      rec.calls.push("deleteNamespacedPod");
    },
  };
}

/**
 * Build a K8sProvider wired to a recording fake. Instead of stubbing the k8s
 * SDK (private, fragile), we bypass `getApi` by pre-populating the private
 * `kubeApi` field via type assertion -- the provider checks `if (this.kubeApi)
 * return this.kubeApi` first, so the real SDK is never touched.
 */
function makeProvider(rec: Recorded): K8sProvider {
  const p = new K8sProvider(app);
  (p as unknown as { kubeApi: unknown }).kubeApi = fakeApi(rec);
  return p;
}

const baseCompute = {
  name: "k8s-e2e-test",
  provider: "k8s" as const,
  compute_kind: "k8s" as const,
  isolation_kind: "direct" as const,
  config: {
    provider: "k8s" as const,
    context: "test-ctx",
    namespace: "ark",
    image: "alpine:3.19",
  },
  status: "running" as const,
  is_template: false,
  cloned_from: null,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

const baseSession = {
  id: "abc12345-0000-0000-0000-000000000000",
  summary: "e2e launch test",
  flow: "e2e-noop",
  stage: "noop",
  status: "ready" as const,
  tenant_id: "default",
  user_id: "system",
  compute_name: "k8s-e2e-test",
} as any;

describe("K8sProvider.launch", async () => {
  let rec: Recorded;
  let provider: K8sProvider;

  beforeEach(() => {
    rec = { lastPod: null, calls: [] };
    provider = makeProvider(rec);
  });

  it("uses /bin/sh (NOT /bin/bash) for the session pod command", async () => {
    await provider.launch(baseCompute as any, baseSession, {
      tmuxName: "ark-abc12345",
      workdir: "/tmp/wd",
      launcherContent: "#!/bin/sh\necho hi",
      ports: [],
    });

    expect(rec.lastPod).toBeTruthy();
    const cmd = rec.lastPod!.spec.containers[0].command;
    expect(cmd[0]).toBe("/bin/sh");
    expect(cmd[1]).toBe("-c");
    expect(cmd[2]).toBe("#!/bin/sh\necho hi");
    // Explicit anti-regression: never fall back to /bin/bash -- that wedges on
    // alpine-based images.
    expect(cmd[0]).not.toBe("/bin/bash");
  });

  it("labels the session pod with ark.dev/session + ark.dev/compute", async () => {
    await provider.launch(baseCompute as any, baseSession, {
      tmuxName: "ark-abc12345",
      workdir: "/tmp/wd",
      launcherContent: "#!/bin/sh\n:",
      ports: [],
    });

    const labels = rec.lastPod!.metadata.labels;
    expect(labels["ark.dev/session"]).toBe(baseSession.id);
    expect(labels["ark.dev/compute"]).toBe("k8s-e2e-test");
  });

  it("places the pod in the configured namespace", async () => {
    const custom = { ...baseCompute, config: { ...baseCompute.config, namespace: "custom-ns" } };
    await provider.launch(custom as any, baseSession, {
      tmuxName: "ark-abc12345",
      workdir: "/tmp/wd",
      launcherContent: "#!/bin/sh\n:",
      ports: [],
    });
    expect(rec.lastPod!.metadata.namespace).toBe("custom-ns");
  });
});

describe("K8sProvider.launch creds mount", async () => {
  let rec: Recorded;
  let provider: K8sProvider;

  beforeEach(() => {
    rec = { lastPod: null, calls: [] };
    provider = makeProvider(rec);
  });

  it("does not add a volumes / volumeMounts field when credsSecretName is absent", async () => {
    // Regression guard: the default (no creds) path must keep the pod body
    // minimal so vanilla action-only flows don't break on clusters that lack
    // the Secret. The existing `k8s e2e flow` action-only case depends on
    // this exact shape.
    await provider.launch(baseCompute as any, baseSession, {
      tmuxName: "ark-abc12345",
      workdir: "/tmp/wd",
      launcherContent: "#!/bin/sh\n:",
      ports: [],
    });
    const spec = rec.lastPod!.spec;
    expect(spec.volumes).toBeUndefined();
    expect(spec.containers[0].volumeMounts).toBeUndefined();
    // And no surprise env var either.
    expect(spec.containers[0].env).toBeUndefined();
  });

  it("mounts the Secret read-only at /root/.claude when credsSecretName is set", async () => {
    const withCreds = {
      ...baseCompute,
      config: { ...baseCompute.config, credsSecretName: "ark-claude-creds" },
    };
    await provider.launch(withCreds as any, baseSession, {
      tmuxName: "ark-abc12345",
      workdir: "/tmp/wd",
      launcherContent: "#!/bin/sh\n:",
      ports: [],
    });

    const spec = rec.lastPod!.spec;
    expect(spec.volumes).toEqual([
      {
        name: "ark-creds",
        secret: {
          secretName: "ark-claude-creds",
          defaultMode: 0o400,
        },
      },
    ]);
    expect(spec.containers[0].volumeMounts).toEqual([
      {
        name: "ark-creds",
        mountPath: "/root/.claude",
        readOnly: true,
      },
    ]);
  });

  it("honours a custom credsMountPath", async () => {
    const withCreds = {
      ...baseCompute,
      config: {
        ...baseCompute.config,
        credsSecretName: "ark-claude-creds",
        credsMountPath: "/home/agent/.claude",
      },
    };
    await provider.launch(withCreds as any, baseSession, {
      tmuxName: "ark-abc12345",
      workdir: "/tmp/wd",
      launcherContent: "#!/bin/sh\n:",
      ports: [],
    });
    const mount = rec.lastPod!.spec.containers[0].volumeMounts[0];
    expect(mount.mountPath).toBe("/home/agent/.claude");
    expect(mount.readOnly).toBe(true);
  });
});

describe("K8sProvider.start (instance pod)", async () => {
  it("uses /bin/sh for the keep-alive command so alpine images work", async () => {
    const rec: Recorded = { lastPod: null, calls: [] };
    const provider = makeProvider(rec);

    await provider.start(baseCompute as any);

    expect(rec.lastPod).toBeTruthy();
    const cmd = rec.lastPod!.spec.containers[0].command;
    expect(cmd[0]).toBe("/bin/sh");
    expect(cmd.join(" ")).toContain("sleep infinity");
    expect(cmd[0]).not.toBe("/bin/bash");
  });
});

describe("K8sProvider.launch securityContext", async () => {
  // The pod-level securityContext block gates admission on clusters
  // enforcing Pod Security Standards "restricted". These tests pin both
  // the omit-when-absent default AND the populated shape so regressions
  // show up in CI before they reach an EKS / GKE / OKE cluster.

  let rec: Recorded;
  let provider: K8sProvider;

  beforeEach(() => {
    rec = { lastPod: null, calls: [] };
    provider = makeProvider(rec);
  });

  it("omits spec.securityContext entirely when none of the hardening fields are set", async () => {
    // Baseline: an unconfigured compute must not emit `securityContext: {}`
    // -- that would still pass admission today but signals "we decided to
    // leave this open" rather than "field absent by default".
    await provider.launch(baseCompute as any, baseSession, {
      tmuxName: "ark-abc12345",
      workdir: "/tmp/wd",
      launcherContent: "#!/bin/sh\n:",
      ports: [],
    });
    expect(rec.lastPod!.spec.securityContext).toBeUndefined();
  });

  it("emits pod-level securityContext when runAsNonRoot is set", async () => {
    const hardened = {
      ...baseCompute,
      config: { ...baseCompute.config, runAsNonRoot: true },
    };
    await provider.launch(hardened as any, baseSession, {
      tmuxName: "ark-abc12345",
      workdir: "/tmp/wd",
      launcherContent: "#!/bin/sh\n:",
      ports: [],
    });
    expect(rec.lastPod!.spec.securityContext).toEqual({ runAsNonRoot: true });
  });

  it("emits all four fields when every knob is configured", async () => {
    // fsGroup in particular matters when credsSecretName is set -- the
    // secret mount needs to be readable by the non-root user.
    const hardened = {
      ...baseCompute,
      config: {
        ...baseCompute.config,
        runAsNonRoot: true,
        runAsUser: 1000,
        runAsGroup: 1000,
        fsGroup: 1000,
      },
    };
    await provider.launch(hardened as any, baseSession, {
      tmuxName: "ark-abc12345",
      workdir: "/tmp/wd",
      launcherContent: "#!/bin/sh\n:",
      ports: [],
    });
    expect(rec.lastPod!.spec.securityContext).toEqual({
      runAsNonRoot: true,
      runAsUser: 1000,
      runAsGroup: 1000,
      fsGroup: 1000,
    });
  });

  it("preserves falsy values (runAsNonRoot: false) instead of dropping them", async () => {
    // A compute that explicitly opts out of non-root enforcement should
    // round-trip the `false` into the pod body -- otherwise an operator
    // who wrote `runAsNonRoot: false` to unblock a legacy image would
    // silently end up with the admission-blocking default. Our builder
    // uses `=== undefined` checks rather than truthiness, so this holds.
    const legacy = {
      ...baseCompute,
      config: { ...baseCompute.config, runAsNonRoot: false, runAsUser: 0 },
    };
    await provider.launch(legacy as any, baseSession, {
      tmuxName: "ark-abc12345",
      workdir: "/tmp/wd",
      launcherContent: "#!/bin/sh\n:",
      ports: [],
    });
    expect(rec.lastPod!.spec.securityContext).toEqual({ runAsNonRoot: false, runAsUser: 0 });
  });
});

describe("K8sProvider.launch clusterName resolution (agent G)", async () => {
  // Exercises the new programmatic-KubeConfig path introduced for Phase 1
  // cluster-access. We stub the @kubernetes/client-node import via the
  // existing `makeProvider` pattern by pre-populating `kubeApi`, but here we
  // also need to drive the KubeConfig construction itself -- that happens
  // inside the provider on the `clusterName` branch. To keep the test narrow
  // and dependency-free we replace `this.app.secrets.get` + set a system-layer
  // cluster, then invoke a private helper via a thin spy.

  it("builds KubeConfig programmatically from resolved cluster + secrets", async () => {
    // Stub the secrets capability on the mode to return a known token.
    const originalMode = app.mode;
    const fakeSecrets = {
      async get(_tid: string, name: string) {
        if (name === "PROD_K8S_TOKEN") return "s3cr3t-token";
        if (name === "PROD_K8S_CA") return "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----";
        return null;
      },
    } as any;
    Object.defineProperty(app, "mode", {
      configurable: true,
      get: () => ({ ...originalMode, secrets: fakeSecrets }),
    });
    // Inject a system-layer cluster via config surgery. Cast because config
    // is readonly in the type but the runtime object is mutable.
    (app.config as any).compute = {
      clusters: [
        {
          name: "prod-us-east",
          kind: "k8s",
          apiEndpoint: "https://prod.k8s.example.com:6443",
          auth: { kind: "token", tokenSecret: "PROD_K8S_TOKEN", caSecret: "PROD_K8S_CA" },
        },
      ],
    };

    // Record what the k8s client loadFromOptions is called with by swapping
    // in a stub KubeConfig via a module-level mock. Simpler: call the private
    // method directly via cast.
    const provider = new K8sProvider(app);
    const recorded: any = { loaded: null, api: null };
    const fakeKc = {
      loadFromOptions(opts: unknown) {
        recorded.loaded = opts;
      },
      loadFromCluster() {
        recorded.loaded = { inCluster: true };
      },
      makeApiClient() {
        recorded.api = { tag: "fake" };
        return recorded.api;
      },
    };
    const fakeModule = { KubeConfig: class {}, CoreV1Api: class {} } as any;
    await (provider as any).buildKubeConfigFromCluster(fakeKc, "prod-us-east", "default", fakeModule);

    // Assert: API endpoint + user token wired up without ever reading disk.
    expect(recorded.loaded).toBeTruthy();
    expect(recorded.loaded.clusters[0].server).toBe("https://prod.k8s.example.com:6443");
    expect(recorded.loaded.currentContext).toBe("prod-us-east-ctx");
    expect(recorded.loaded.users[0].token).toBe("s3cr3t-token");
    // CA was provided via caSecret, encoded base64 for kc.loadFromOptions.
    expect(recorded.loaded.clusters[0].caData).toBeTruthy();
    expect(recorded.loaded.clusters[0].skipTLSVerify).toBeUndefined();

    Object.defineProperty(app, "mode", { configurable: true, get: () => originalMode });
  });

  it("fails fast when a referenced secret is missing for the tenant", async () => {
    const originalMode = app.mode;
    const fakeSecrets = {
      async get(_tid: string, _name: string) {
        return null;
      },
    } as any;
    Object.defineProperty(app, "mode", {
      configurable: true,
      get: () => ({ ...originalMode, secrets: fakeSecrets }),
    });
    (app.config as any).compute = {
      clusters: [
        {
          name: "staging",
          kind: "k8s",
          apiEndpoint: "https://staging.example.com",
          auth: { kind: "token", tokenSecret: "MISSING_TOKEN" },
        },
      ],
    };

    const provider = new K8sProvider(app);
    const fakeKc = {
      loadFromOptions() {},
      loadFromCluster() {},
      makeApiClient() {
        return {};
      },
    };
    await expect((provider as any).buildKubeConfigFromCluster(fakeKc, "staging", "acme", {} as any)).rejects.toThrow(
      /requires secret "MISSING_TOKEN"/,
    );

    Object.defineProperty(app, "mode", { configurable: true, get: () => originalMode });
  });

  it("rejects unknown cluster name with the available list", async () => {
    (app.config as any).compute = {
      clusters: [
        {
          name: "only-one",
          kind: "k8s",
          apiEndpoint: "https://a.example.com",
          auth: { kind: "in_cluster" },
        },
      ],
    };
    const provider = new K8sProvider(app);
    const fakeKc = {
      loadFromOptions() {},
      loadFromCluster() {},
      makeApiClient() {
        return {};
      },
    };
    await expect((provider as any).buildKubeConfigFromCluster(fakeKc, "nope", "default", {} as any)).rejects.toThrow(
      /not in effective list.*Available: only-one/,
    );
  });

  it("uses loadFromCluster() for in_cluster auth and skips the secret fetch", async () => {
    (app.config as any).compute = {
      clusters: [
        {
          name: "pod-local",
          kind: "k8s",
          apiEndpoint: "https://kubernetes.default.svc",
          auth: { kind: "in_cluster" },
        },
      ],
    };
    const provider = new K8sProvider(app);
    const recorded: any = { loaded: null };
    const fakeKc = {
      loadFromOptions(opts: unknown) {
        recorded.loaded = opts;
      },
      loadFromCluster() {
        recorded.loaded = { inCluster: true };
      },
      makeApiClient() {
        return {};
      },
    };
    await (provider as any).buildKubeConfigFromCluster(fakeKc, "pod-local", "default", {} as any);
    expect(recorded.loaded).toEqual({ inCluster: true });
  });
});

describe("K8sProvider.start (instance pod) securityContext", async () => {
  it("applies the same pod-level securityContext as launch()", async () => {
    // Parity: the instance pod (keep-alive `sleep infinity`) must honour
    // the hardening knobs too, otherwise `Start` on a restricted-PSS
    // cluster silently fails admission while `launch()` succeeds.
    const rec: Recorded = { lastPod: null, calls: [] };
    const provider = makeProvider(rec);

    const hardened = {
      ...baseCompute,
      config: { ...baseCompute.config, runAsNonRoot: true, runAsUser: 1000 },
    };
    await provider.start(hardened as any);

    expect(rec.lastPod!.spec.securityContext).toEqual({ runAsNonRoot: true, runAsUser: 1000 });
  });

  it("omits securityContext from the instance pod when none of the knobs are set", async () => {
    const rec: Recorded = { lastPod: null, calls: [] };
    const provider = makeProvider(rec);
    await provider.start(baseCompute as any);
    expect(rec.lastPod!.spec.securityContext).toBeUndefined();
  });
});
