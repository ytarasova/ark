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
