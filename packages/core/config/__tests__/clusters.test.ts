/**
 * Tests for the cluster config layering + YAML parsing introduced in agent-G
 * (Phase 1 of the cluster-access story).
 *
 * Covered surfaces:
 *   - parseClustersYaml     -- shape validation, auth-kind variants, errors.
 *   - mergeClusterLayers    -- later layer wins per-cluster-name, full replace.
 *   - resolveEffectiveClusters -- end-to-end (system ∪ tenant) merge against
 *     a live AppContext + TenantPolicyManager.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";

import { AppContext } from "../../app.js";
import { setApp, clearApp } from "../../__tests__/test-helpers.js";
import { parseClustersYaml, mergeClusterLayers, resolveEffectiveClusters, type ClusterConfig } from "../clusters.js";
import { TenantPolicyManager } from "../../auth/tenant-policy.js";

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

describe("parseClustersYaml", () => {
  it("accepts a top-level array", () => {
    const yaml = `
- name: a
  kind: k8s
  apiEndpoint: https://a.example.com
  auth:
    kind: in_cluster
`;
    const parsed = parseClustersYaml(yaml);
    expect(parsed.length).toBe(1);
    expect(parsed[0].name).toBe("a");
    expect(parsed[0].auth.kind).toBe("in_cluster");
  });

  it("accepts `clusters: [...]` wrapper for ergonomic YAML", () => {
    const yaml = `
clusters:
  - name: a
    kind: k8s-kata
    apiEndpoint: https://a.example.com
    auth:
      kind: token
      tokenSecret: A_TOKEN
`;
    const parsed = parseClustersYaml(yaml);
    expect(parsed.length).toBe(1);
    expect(parsed[0].kind).toBe("k8s-kata");
    if (parsed[0].auth.kind === "token") {
      expect(parsed[0].auth.tokenSecret).toBe("A_TOKEN");
    } else {
      throw new Error("expected token auth");
    }
  });

  it("rejects malformed YAML with a clear error", () => {
    expect(() => parseClustersYaml(":\nnot valid yaml: [")).toThrow(/Invalid YAML/);
  });

  it("rejects missing required fields", () => {
    const yaml = `
- kind: k8s
  auth:
    kind: in_cluster
`;
    expect(() => parseClustersYaml(yaml)).toThrow(/name.*required/);
  });

  it("rejects unknown auth kinds", () => {
    const yaml = `
- name: a
  kind: k8s
  apiEndpoint: https://a.example.com
  auth:
    kind: magic
`;
    expect(() => parseClustersYaml(yaml)).toThrow(/auth.kind.*in_cluster.*token.*client_cert/);
  });

  it("requires tokenSecret for token auth", () => {
    const yaml = `
- name: a
  kind: k8s
  apiEndpoint: https://a.example.com
  auth:
    kind: token
`;
    expect(() => parseClustersYaml(yaml)).toThrow(/tokenSecret.*required/);
  });

  it("requires certSecret AND keySecret for client_cert auth", () => {
    const missingKey = `
- name: a
  kind: k8s
  apiEndpoint: https://a.example.com
  auth:
    kind: client_cert
    certSecret: C
`;
    expect(() => parseClustersYaml(missingKey)).toThrow(/keySecret.*required/);
  });
});

describe("mergeClusterLayers", () => {
  const base: ClusterConfig[] = [
    {
      name: "prod",
      kind: "k8s",
      apiEndpoint: "https://prod.system.example.com",
      auth: { kind: "in_cluster" },
    },
    {
      name: "staging",
      kind: "k8s",
      apiEndpoint: "https://staging.system.example.com",
      auth: { kind: "in_cluster" },
    },
  ];

  it("returns base unchanged when overlay is empty", () => {
    expect(mergeClusterLayers(base, [])).toEqual(base);
  });

  it("appends overlay entries that don't collide with base", () => {
    const overlay: ClusterConfig[] = [
      {
        name: "dev",
        kind: "k8s",
        apiEndpoint: "https://dev.overlay.example.com",
        auth: { kind: "in_cluster" },
      },
    ];
    const merged = mergeClusterLayers(base, overlay);
    expect(merged.map((c) => c.name)).toEqual(["prod", "staging", "dev"]);
  });

  it("overlay fully replaces base entry on name collision (no field merge)", () => {
    const overlay: ClusterConfig[] = [
      {
        name: "prod",
        kind: "k8s-kata",
        apiEndpoint: "https://prod.OVERLAY.example.com",
        auth: { kind: "token", tokenSecret: "OVER_TOKEN" },
      },
    ];
    const merged = mergeClusterLayers(base, overlay);
    const prod = merged.find((c) => c.name === "prod")!;
    expect(prod.kind).toBe("k8s-kata");
    expect(prod.apiEndpoint).toBe("https://prod.OVERLAY.example.com");
    expect(prod.auth.kind).toBe("token");
    // base-only fields NOT re-merged: full replacement.
    expect(merged.length).toBe(2);
  });
});

describe("resolveEffectiveClusters (system ∪ tenant)", () => {
  it("returns system clusters when no tenant override is set", async () => {
    (app.config as any).compute = {
      clusters: [
        {
          name: "sys-1",
          kind: "k8s",
          apiEndpoint: "https://sys-1.example.com",
          auth: { kind: "in_cluster" },
        },
      ],
    };
    // Use a unique tenant id so we don't trip over state from other tests.
    const clusters = await resolveEffectiveClusters(app, "test-tenant-no-overlay");
    expect(clusters.map((c) => c.name)).toEqual(["sys-1"]);
  });

  it("tenant overlay wins on name collision (full replacement)", async () => {
    // Arrange: system cluster named "prod"; tenant overlay replaces it.
    (app.config as any).compute = {
      clusters: [
        {
          name: "prod",
          kind: "k8s",
          apiEndpoint: "https://prod.SYSTEM.example.com",
          auth: { kind: "in_cluster" },
        },
        {
          name: "dev",
          kind: "k8s",
          apiEndpoint: "https://dev.system.example.com",
          auth: { kind: "in_cluster" },
        },
      ],
    };

    const tenantId = "collision-tenant";
    const overlayYaml = `
- name: prod
  kind: k8s-kata
  apiEndpoint: https://prod.TENANT.example.com
  auth:
    kind: token
    tokenSecret: PROD_TOKEN
`;
    const mgr = new TenantPolicyManager(app.db);
    await mgr.setComputeConfig(tenantId, overlayYaml);

    // Act
    const effective = await resolveEffectiveClusters(app, tenantId);

    // Assert: tenant "prod" wins, system "dev" survives.
    const prod = effective.find((c) => c.name === "prod")!;
    expect(prod.kind).toBe("k8s-kata");
    expect(prod.apiEndpoint).toBe("https://prod.TENANT.example.com");
    expect(prod.auth.kind).toBe("token");
    const names = effective.map((c) => c.name);
    expect(names).toContain("prod");
    expect(names).toContain("dev");
  });

  it("malformed tenant YAML does not crash resolution; falls back to system-only", async () => {
    (app.config as any).compute = {
      clusters: [
        {
          name: "system",
          kind: "k8s",
          apiEndpoint: "https://system.example.com",
          auth: { kind: "in_cluster" },
        },
      ],
    };
    const tenantId = "malformed-yaml-tenant";
    const mgr = new TenantPolicyManager(app.db);
    // Bypass the validator by writing directly (simulates a pre-existing
    // bad row, e.g. from a prior schema). The live `setComputeConfig` is
    // intentionally unchecked; validation happens in the handler.
    await mgr.setComputeConfig(tenantId, "::: invalid yaml [");
    const effective = await resolveEffectiveClusters(app, tenantId);
    expect(effective.map((c) => c.name)).toEqual(["system"]);
  });
});
