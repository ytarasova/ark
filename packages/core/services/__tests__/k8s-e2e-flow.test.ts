/**
 * End-to-end k8s flow test -- drives the action-only `e2e-noop` flow against
 * a REAL Kubernetes cluster and asserts the session reaches
 * `status: completed` without manual intervention, without leaking pods,
 * and without leaking DB rows.
 *
 * **Gated on `E2E_K8S_CLUSTER`**. Skipped by default so CI can't accidentally
 * create pods in whatever `~/.kube/config` happens to point at. To run:
 *
 *   E2E_K8S_CLUSTER=arn:aws:eks:...:cluster/foo \
 *   E2E_K8S_NAMESPACE=ark \
 *   E2E_K8S_IMAGE=alpine:3.19 \
 *   bun test packages/core/services/__tests__/k8s-e2e-flow.test.ts
 *
 * The test exercises the full dispatch pipeline in local mode -- the
 * hosted control-plane variant is hit manually during release triage (see
 * the scratch `e2e-k8s.sh` driver). Local mode is enough to catch the
 * failure classes that bit us on the live cluster:
 *   - alpine images no longer fail on `/bin/bash` (provider launcher cmd)
 *   - action-only first stages dispatch auto-execute to completion
 *   - template-clone GC fires when the session terminates
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { AppContext } from "../../app.js";
import { startSession, waitForCompletion } from "../session-lifecycle.js";
import { dispatch } from "../dispatch.js";

const CLUSTER = process.env.E2E_K8S_CLUSTER;
const NAMESPACE = process.env.E2E_K8S_NAMESPACE ?? "ark";
const IMAGE = process.env.E2E_K8S_IMAGE ?? "alpine:3.19";

// Describe block runs unconditionally so CI output makes the skip visible;
// each `it` bails early if the cluster env var is absent. This matches the
// existing convention used in other environment-gated tests.
describe("k8s e2e flow (live cluster)", () => {
  if (!CLUSTER) {
    it("skipped -- set E2E_K8S_CLUSTER to run", () => {
      expect(CLUSTER).toBeUndefined();
    });
    return;
  }

  let app: AppContext;
  const templateName = `e2e-k8s-tpl-${Date.now().toString(36)}`;
  let cloneName = "";
  let sessionId = "";

  beforeAll(async () => {
    app = await AppContext.forTestAsync();
    await app.boot();

    // Install the single-stage noop flow. Using `close_ticket` keeps the
    // test dependency-free: no Anthropic / OpenAI quota, no arkd, no tmux.
    await app.flows.save("e2e-noop", {
      name: "e2e-noop",
      description: "E2E noop",
      stages: [{ name: "noop", action: "close_ticket", gate: "auto" }],
    } as never);

    // Template compute. The server usually validates `context/namespace/image`
    // at create time via the k8s guard in `resource.ts`; here we go straight
    // through the repository so the test doesn't need the full RPC layer.
    await app.computes.create({
      name: templateName,
      compute: "k8s",
      runtime: "direct",
      config: { context: CLUSTER, namespace: NAMESPACE, image: IMAGE },
      is_template: true,
    });
  });

  afterAll(async () => {
    // Best-effort cleanup: delete any residual clone + template rows. Real
    // pod teardown is the GC path's responsibility; if GC failed this
    // afterAll can't rescue the cluster, so we just log.
    if (cloneName) {
      try {
        await app.computes.delete(cloneName);
      } catch {
        /* already gc'd */
      }
    }
    try {
      await app.computes.delete(templateName);
    } catch {
      /* already gone */
    }
    await app?.shutdown();
  });

  it("provisions the k8s template into a live instance pod", async () => {
    const { getProvider } = await import("../../../compute/index.js");
    const provider = getProvider("k8s");
    expect(provider).toBeTruthy();

    // Mirror `compute/provision` RPC: clone template into concrete row,
    // then provision + start to bring up the instance pod.
    cloneName = `${templateName}-${Math.random().toString(36).slice(2, 8)}`;
    const tmpl = (await app.computes.get(templateName))!;
    await app.computes.create({
      name: cloneName,
      provider: tmpl.provider,
      compute: tmpl.compute_kind,
      runtime: tmpl.runtime_kind,
      config: JSON.parse(JSON.stringify(tmpl.config ?? {})),
      is_template: false,
      cloned_from: tmpl.name,
    });
    const clone = (await app.computes.get(cloneName))!;
    await provider!.provision(clone);
    await provider!.start(clone);

    const fresh = (await app.computes.get(cloneName))!;
    expect(fresh.status).toBe("running");
  });

  it("starts a session on e2e-noop and reaches status=completed", async () => {
    const session = await startSession(app, {
      summary: "e2e-noop test",
      flow: "e2e-noop",
      repo: "/tmp",
      compute_name: cloneName,
    });
    sessionId = session.id;
    expect(session.flow).toBe("e2e-noop");
    expect(session.stage).toBe("noop");
    expect(session.status).toBe("ready");

    // Kick dispatch explicitly -- the `forTestAsync` AppContext doesn't
    // register the default session_created listener the hosted server
    // does, so we drive the same code path directly.
    const kicked = await dispatch(app, sessionId);
    expect(kicked.ok).toBe(true);

    const { session: finalSession, timedOut } = await waitForCompletion(app, sessionId, {
      timeoutMs: 60_000,
      pollMs: 500,
    });
    expect(timedOut).toBe(false);
    expect(finalSession?.status).toBe("completed");
  });

  it("logs action_executed + session_completed events", async () => {
    const events = await app.events.list(sessionId);
    const actionEvents = events.filter((e) => e.type === "action_executed");
    expect(actionEvents.length).toBeGreaterThanOrEqual(1);
    expect(actionEvents.some((e) => (e.data as { action?: string } | null)?.action === "close_ticket")).toBe(true);

    const completed = events.filter((e) => e.type === "session_completed");
    expect(completed.length).toBe(1);
  });

  it("GCs the clone compute row after the session completes", async () => {
    // compute-lifecycle.garbageCollectComputeIfTemplate fires inside
    // stage-advance on terminal transition. The clone should already be
    // gone by the time the session hits `completed`.
    expect(await app.computes.get(cloneName)).toBeNull();
    // Clear the handle so `afterAll` doesn't try to delete an already-gone row.
    cloneName = "";
  });
});

/**
 * Session-pod variant -- exercises `K8sProvider.launch` end-to-end by running
 * an agent stage that calls Claude Code inside the pod. Gated on BOTH
 * `E2E_K8S_CLUSTER` (the cluster gate reused from the action-only case) AND
 * `E2E_K8S_WITH_CLAUDE=1` (an explicit opt-in for the creds-mount variant).
 * CI must never set the second gate -- the test depends on a live Claude
 * subscription on the operator's workstation.
 *
 * Setup that the test does on your behalf:
 *   1. Reads the local claude home dir from `CLAUDE_SUBSCRIPTION_PATH`
 *      (default `~/.claude`), loads every regular file under it, and creates
 *      a Kubernetes Secret in `E2E_K8S_NAMESPACE` containing those files.
 *   2. Patches the k8s compute row with `credsSecretName` so
 *      `K8sProvider.launch` mounts the Secret at `/root/.claude`.
 *   3. Saves a minimal throwaway agent + a single-stage flow
 *      (`e2e-noop-agent`) into the test AppContext.
 *   4. Starts a session, waits up to 90 s for it to reach `completed`, and
 *      asserts zero leaked pods + Secret deletion on teardown.
 *
 * The agent prompt is intentionally trivial ("write hello world to /tmp/ark-e2e-hello.txt
 * and exit") -- the goal is to prove the pipe, not to stress Claude.
 */
const WITH_CLAUDE = process.env.E2E_K8S_WITH_CLAUDE === "1";
const CLAUDE_SUBSCRIPTION_PATH = process.env.CLAUDE_SUBSCRIPTION_PATH ?? `${process.env.HOME ?? ""}/.claude`;
const E2E_IMAGE_WITH_CLAUDE = process.env.E2E_K8S_IMAGE_WITH_CLAUDE ?? "ghcr.io/anthropics/claude-code:latest";

describe("k8s e2e flow -- session pod + agent stage (live cluster + live claude)", () => {
  if (!CLUSTER || !WITH_CLAUDE) {
    it("skipped -- set E2E_K8S_CLUSTER and E2E_K8S_WITH_CLAUDE=1 to run", () => {
      // Two gates: the cluster gate keeps CI from touching a real cluster at
      // all; the WITH_CLAUDE gate keeps even cluster-enabled developers from
      // accidentally running this variant without a live subscription.
      expect(CLUSTER && WITH_CLAUDE).toBeFalsy();
    });
    return;
  }

  let app: AppContext;
  const templateName = `e2e-k8s-agent-tpl-${Date.now().toString(36)}`;
  const secretName = `ark-claude-creds-${Date.now().toString(36)}`;
  let cloneName = "";
  let sessionId = "";
  let api: any;

  beforeAll(async () => {
    app = await AppContext.forTestAsync();
    await app.boot();

    // Minimal throwaway agent. Written here (rather than in agents/) so the
    // agent catalog stays free of E2E-only entries. `runtime: claude-max`
    // picks up the subscription runtime YAML we ship in runtimes/.
    await app.agents.save(
      "e2e-noop-agent",
      {
        name: "e2e-noop-agent",
        description: "E2E test agent -- writes a file then exits",
        runtime: "claude-max",
        model: "haiku",
        max_turns: 3,
        system_prompt:
          "You are a test agent. Write the literal string 'hello from ark k8s e2e' " +
          "to the file /tmp/ark-e2e-hello.txt, then call `report` with type='completed'. Do nothing else.",
        tools: ["Bash", "Write"],
        mcp_servers: [],
        skills: [],
        memories: [],
        context: [],
        permission_mode: "bypassPermissions",
        env: {},
      } as never,
      "global",
    );

    await app.flows.save("e2e-noop-agent", {
      name: "e2e-noop-agent",
      description: "E2E noop agent stage",
      stages: [{ name: "work", agent: "e2e-noop-agent", gate: "auto" }],
    } as never);

    // Template compute.
    await app.computes.create({
      name: templateName,
      compute: "k8s",
      runtime: "direct",
      config: { context: CLUSTER, namespace: NAMESPACE, image: E2E_IMAGE_WITH_CLAUDE },
      is_template: true,
    });

    // Build the creds Secret out of the operator's local claude home dir.
    // We read lazily here (not at module top level) so the skip-path above
    // never touches the filesystem.
    const fs = await import("fs");
    const path = await import("path");
    if (!fs.existsSync(CLAUDE_SUBSCRIPTION_PATH)) {
      throw new Error(
        `CLAUDE_SUBSCRIPTION_PATH=${CLAUDE_SUBSCRIPTION_PATH} does not exist. ` +
          `Set CLAUDE_SUBSCRIPTION_PATH to your local claude creds dir (usually ~/.claude).`,
      );
    }
    const entries = fs.readdirSync(CLAUDE_SUBSCRIPTION_PATH, { withFileTypes: true });
    const data: Record<string, string> = {};
    for (const e of entries) {
      if (!e.isFile()) continue; // skip subdirs -- flatten one level only
      const full = path.join(CLAUDE_SUBSCRIPTION_PATH, e.name);
      const buf = fs.readFileSync(full);
      data[e.name] = buf.toString("base64");
    }

    const { getProvider } = await import("../../../compute/index.js");
    const provider = getProvider("k8s");
    const { K8sProvider } = await import("../../../compute/providers/k8s.js");
    // Borrow the provider's lazy getApi by provisioning first -- that
    // populates `kubeApi`. We stash it on a local for Secret CRUD below.
    const tmpl = (await app.computes.get(templateName))!;
    await provider!.provision(tmpl);
    api = (provider as unknown as { kubeApi: any }).kubeApi;
    expect(provider instanceof K8sProvider).toBe(true);

    try {
      await api.deleteNamespacedSecret({ name: secretName, namespace: NAMESPACE });
    } catch {
      /* fine, first run */
    }
    await api.createNamespacedSecret({
      namespace: NAMESPACE,
      body: {
        metadata: { name: secretName, namespace: NAMESPACE, labels: { "ark.dev/e2e": "1" } },
        type: "Opaque",
        data,
      },
    });
  });

  afterAll(async () => {
    // Secret teardown first -- if anything below throws, we still don't want
    // the creds lingering in a shared namespace.
    if (api) {
      try {
        await api.deleteNamespacedSecret({ name: secretName, namespace: NAMESPACE });
      } catch {
        /* already gone */
      }
    }
    if (cloneName) {
      try {
        await app.computes.delete(cloneName);
      } catch {
        /* already gc'd */
      }
    }
    try {
      await app.computes.delete(templateName);
    } catch {
      /* already gone */
    }
    await app?.shutdown();
  });

  it("provisions the clone + wires the creds Secret into the config", async () => {
    const { getProvider } = await import("../../../compute/index.js");
    const provider = getProvider("k8s");
    expect(provider).toBeTruthy();

    cloneName = `${templateName}-${Math.random().toString(36).slice(2, 8)}`;
    const tmpl = (await app.computes.get(templateName))!;
    await app.computes.create({
      name: cloneName,
      provider: tmpl.provider,
      compute: tmpl.compute_kind,
      runtime: tmpl.runtime_kind,
      // Inject the creds Secret reference into the clone's config so
      // `launch()` mounts it on the session pod. We mutate a deep copy --
      // never the template's live config object.
      config: { ...(JSON.parse(JSON.stringify(tmpl.config ?? {})) as object), credsSecretName: secretName },
      is_template: false,
      cloned_from: tmpl.name,
    });
    const clone = (await app.computes.get(cloneName))!;
    await provider!.provision(clone);
    await provider!.start(clone);
    const fresh = (await app.computes.get(cloneName))!;
    expect(fresh.status).toBe("running");
    expect((fresh.config as any).credsSecretName).toBe(secretName);
  });

  it("runs the agent stage to completed inside the session pod", async () => {
    const session = await startSession(app, {
      summary: "e2e-noop-agent test",
      flow: "e2e-noop-agent",
      repo: "/tmp",
      compute_name: cloneName,
    });
    sessionId = session.id;
    expect(session.flow).toBe("e2e-noop-agent");
    expect(session.stage).toBe("work");
    expect(session.status).toBe("ready");

    const kicked = await dispatch(app, sessionId);
    expect(kicked.ok).toBe(true);

    // 90 s budget: pod schedule (~10 s) + image pull (skip if warm) +
    // claude haiku round-trip (~15 s) + launcher teardown. On a cold cluster
    // with a large image pull this may need to be bumped, but the test
    // target is specifically the warm-cluster iteration loop.
    const { session: finalSession, timedOut } = await waitForCompletion(app, sessionId, {
      timeoutMs: 90_000,
      pollMs: 1000,
    });
    expect(timedOut).toBe(false);
    expect(finalSession?.status).toBe("completed");
  });

  it("leaks zero pods after the session completes", async () => {
    // Session pod name is `ark-<sessionId>`. killAgent fires on terminal
    // transition; we assert the cluster actually forgot about the pod.
    const list = await api.listNamespacedPod({
      namespace: NAMESPACE,
      labelSelector: `ark.dev/session=${sessionId}`,
    });
    const items: any[] = list.items ?? [];
    expect(items.length).toBe(0);
  });

  it("GCs the clone compute row after the session completes", async () => {
    expect(await app.computes.get(cloneName)).toBeNull();
    cloneName = "";
  });
});
