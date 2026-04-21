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
  const p = new K8sProvider();
  p.setApp(app);
  (p as unknown as { kubeApi: unknown }).kubeApi = fakeApi(rec);
  return p;
}

const baseCompute = {
  name: "k8s-e2e-test",
  provider: "k8s" as const,
  compute_kind: "k8s" as const,
  runtime_kind: "direct" as const,
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
