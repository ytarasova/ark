/**
 * Unit tests for the boot-time creds Secret reconciler.
 *
 * The reconciler sweeps Secrets labeled `ark.dev/session-creds=true` in
 * every configured cluster, keeps Secrets that already have an owner-ref
 * (k8s GC owns them), and deletes Secrets whose backing session is gone
 * or in a terminal state. Active sessions are left alone on the
 * assumption that a late `setSecretOwnerToPod` will attach the
 * owner-ref.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { AppContext } from "../../app.js";
import { setApp, clearApp } from "../../__tests__/test-helpers.js";
import { reconcileOrphanedCredsSecrets, type ClusterTarget } from "../creds-secret-reconciler.js";
import type { K8sSecretsApi } from "../dispatch-claude-auth.js";

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

/** In-memory cluster stub. Each entry is `{name, metadata: {...}}`. */
class StubClusterApi implements K8sSecretsApi {
  items: any[] = [];
  deletedNames: string[] = [];
  listFails = false;

  async createNamespacedSecret() {
    return {};
  }
  async deleteNamespacedSecret(args: { name: string; namespace: string }) {
    this.deletedNames.push(args.name);
    const idx = this.items.findIndex((i) => i.metadata?.name === args.name);
    if (idx >= 0) this.items.splice(idx, 1);
    else {
      // Mimic real k8s 404 on repeat-delete.
      throw { statusCode: 404, body: { code: 404 } };
    }
    return {};
  }
  async patchNamespacedSecret() {
    return {};
  }
  async listNamespacedSecret(_args: { namespace: string; labelSelector?: string }) {
    if (this.listFails) throw new Error("list exploded");
    return { items: this.items };
  }
}

function secretItem(opts: { name: string; sessionId: string | null; withOwnerRef: boolean }): any {
  const labels: Record<string, string> = { "ark.dev/session-creds": "true" };
  if (opts.sessionId) labels["ark.dev/session"] = opts.sessionId;
  return {
    metadata: {
      name: opts.name,
      labels,
      ...(opts.withOwnerRef
        ? { ownerReferences: [{ apiVersion: "v1", kind: "Pod", name: "owner", uid: "u1", controller: false }] }
        : {}),
    },
  };
}

async function makeTerminalSession(): Promise<string> {
  const s = await app.sessions.create({ summary: "terminal", flow: "quick" });
  await app.sessions.update(s.id, { status: "completed" });
  return s.id;
}

async function makeActiveSession(): Promise<string> {
  const s = await app.sessions.create({ summary: "active", flow: "quick" });
  await app.sessions.update(s.id, { status: "running" });
  return s.id;
}

describe("reconcileOrphanedCredsSecrets", () => {
  let stub: StubClusterApi;
  let targets: ClusterTarget[];

  beforeEach(() => {
    stub = new StubClusterApi();
    targets = [{ clusterName: "test-cluster", namespace: "ark-test", api: stub }];
  });

  it("leaves owner-ref Secrets alone, deletes orphans of terminal/missing sessions, keeps active orphans", async () => {
    const terminalId = await makeTerminalSession();
    const activeId = await makeActiveSession();

    stub.items = [
      // 1. Has ownerReferences -> skipped entirely.
      secretItem({ name: "ark-creds-owned", sessionId: terminalId, withOwnerRef: true }),
      // 2. Orphan + terminal session -> deleted.
      secretItem({ name: "ark-creds-terminal", sessionId: terminalId, withOwnerRef: false }),
      // 3. Orphan + missing session -> deleted.
      secretItem({ name: "ark-creds-missing", sessionId: "00000000-ffff-ffff-ffff-000000000000", withOwnerRef: false }),
      // 4. Orphan + active session -> kept with warning.
      secretItem({ name: "ark-creds-active", sessionId: activeId, withOwnerRef: false }),
    ];

    const result = await reconcileOrphanedCredsSecrets(app, { clusterTargets: async () => targets });

    expect(result.deleted).toBe(2);
    expect(result.kept).toBe(1);
    expect(result.errors).toEqual([]);
    expect(stub.deletedNames.sort()).toEqual(["ark-creds-missing", "ark-creds-terminal"]);
    // Owner-ref one + active orphan remain.
    const remaining = stub.items.map((i) => i.metadata.name).sort();
    expect(remaining).toEqual(["ark-creds-active", "ark-creds-owned"]);
  });

  it("is idempotent -- a second run is a no-op once terminal orphans are gone", async () => {
    const terminalId = await makeTerminalSession();
    stub.items = [secretItem({ name: "ark-creds-t2", sessionId: terminalId, withOwnerRef: false })];

    const r1 = await reconcileOrphanedCredsSecrets(app, { clusterTargets: async () => targets });
    expect(r1.deleted).toBe(1);

    const r2 = await reconcileOrphanedCredsSecrets(app, { clusterTargets: async () => targets });
    expect(r2.deleted).toBe(0);
    expect(r2.kept).toBe(0);
    expect(r2.errors).toEqual([]);
  });

  it("swallows list errors per cluster and surfaces them in result.errors", async () => {
    stub.listFails = true;
    const result = await reconcileOrphanedCredsSecrets(app, { clusterTargets: async () => targets });
    expect(result.deleted).toBe(0);
    expect(result.kept).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("list exploded");
  });

  it("returns empty when no clusters are configured", async () => {
    const result = await reconcileOrphanedCredsSecrets(app, { clusterTargets: async () => [] });
    expect(result).toEqual({ deleted: 0, kept: 0, errors: [] });
  });

  it("swallows errors from the cluster enumerator itself", async () => {
    const result = await reconcileOrphanedCredsSecrets(app, {
      clusterTargets: async () => {
        throw new Error("cluster config blew up");
      },
    });
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("cluster config blew up");
  });
});
