import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { AppContext } from "../app.js";
import { TenantPolicyManager } from "../auth/index.js";

let app: AppContext;
let pm: TenantPolicyManager;

beforeAll(async () => {
  app = await AppContext.forTestAsync();
  await app.boot();
  pm = new TenantPolicyManager(app.db);
});

afterAll(async () => {
  await app?.shutdown();
});

describe("TenantPolicyManager", async () => {
  describe("getPolicy / setPolicy", async () => {
    it("returns null for non-existent tenant", async () => {
      expect(await pm.getPolicy("nonexistent")).toBeNull();
    });

    it("creates and retrieves a policy", async () => {
      await pm.setPolicy({
        tenant_id: "tenant-a",
        allowed_providers: ["k8s", "ec2"],
        default_provider: "k8s",
        max_concurrent_sessions: 20,
        max_cost_per_day_usd: 50.0,
        compute_pools: [{ pool_name: "pool-1", provider: "k8s", min: 1, max: 5, config: { namespace: "prod" } }],
      });

      const policy = await pm.getPolicy("tenant-a");
      expect(policy).not.toBeNull();
      expect(policy!.tenant_id).toBe("tenant-a");
      expect(policy!.allowed_providers).toEqual(["k8s", "ec2"]);
      expect(policy!.default_provider).toBe("k8s");
      expect(policy!.max_concurrent_sessions).toBe(20);
      expect(policy!.max_cost_per_day_usd).toBe(50.0);
      expect(policy!.compute_pools).toHaveLength(1);
      expect(policy!.compute_pools[0].pool_name).toBe("pool-1");
      expect(policy!.compute_pools[0].config).toEqual({ namespace: "prod" });
    });

    it("updates an existing policy", async () => {
      await pm.setPolicy({
        tenant_id: "tenant-a",
        allowed_providers: ["k8s"],
        default_provider: "k8s",
        max_concurrent_sessions: 5,
        max_cost_per_day_usd: null,
        compute_pools: [],
      });

      const policy = await pm.getPolicy("tenant-a");
      expect(policy!.allowed_providers).toEqual(["k8s"]);
      expect(policy!.max_concurrent_sessions).toBe(5);
      expect(policy!.max_cost_per_day_usd).toBeNull();
      expect(policy!.compute_pools).toEqual([]);
    });
  });

  describe("getEffectivePolicy", async () => {
    it("returns default policy for unknown tenant", async () => {
      const policy = await pm.getEffectivePolicy("unknown-tenant");
      expect(policy.tenant_id).toBe("unknown-tenant");
      expect(policy.allowed_providers).toEqual([]);
      expect(policy.default_provider).toBe("k8s");
      expect(policy.max_concurrent_sessions).toBe(10);
      expect(policy.max_cost_per_day_usd).toBeNull();
    });

    it("returns explicit policy when set", async () => {
      await pm.setPolicy({
        tenant_id: "tenant-b",
        allowed_providers: ["ec2"],
        default_provider: "ec2",
        max_concurrent_sessions: 3,
        max_cost_per_day_usd: 100.0,
        compute_pools: [],
      });

      const policy = await pm.getEffectivePolicy("tenant-b");
      expect(policy.allowed_providers).toEqual(["ec2"]);
      expect(policy.default_provider).toBe("ec2");
      expect(policy.max_concurrent_sessions).toBe(3);
    });
  });

  describe("deletePolicy", async () => {
    it("deletes an existing policy", async () => {
      await pm.setPolicy({
        tenant_id: "tenant-del",
        allowed_providers: [],
        default_provider: "k8s",
        max_concurrent_sessions: 10,
        max_cost_per_day_usd: null,
        compute_pools: [],
      });

      expect(await pm.getPolicy("tenant-del")).not.toBeNull();
      const result = await pm.deletePolicy("tenant-del");
      expect(result).toBe(true);
      expect(await pm.getPolicy("tenant-del")).toBeNull();
    });

    it("returns false when deleting non-existent policy", async () => {
      const result = await pm.deletePolicy("nonexistent-del");
      expect(result).toBe(false);
    });
  });

  describe("listPolicies", async () => {
    it("lists all policies", async () => {
      // Clear all policies for a clean test
      const existing = await pm.listPolicies();
      for (const p of existing) await pm.deletePolicy(p.tenant_id);

      await pm.setPolicy({
        tenant_id: "list-a",
        allowed_providers: ["k8s"],
        default_provider: "k8s",
        max_concurrent_sessions: 10,
        max_cost_per_day_usd: null,
        compute_pools: [],
      });
      await pm.setPolicy({
        tenant_id: "list-b",
        allowed_providers: ["ec2", "docker"],
        default_provider: "ec2",
        max_concurrent_sessions: 5,
        max_cost_per_day_usd: 25.0,
        compute_pools: [],
      });

      const policies = await pm.listPolicies();
      expect(policies.length).toBe(2);
      expect(policies.map((p) => p.tenant_id)).toContain("list-a");
      expect(policies.map((p) => p.tenant_id)).toContain("list-b");
    });
  });

  describe("isProviderAllowed", async () => {
    it("allows all providers when allowed_providers is empty", async () => {
      // Default policy has empty allowed_providers
      expect(await pm.isProviderAllowed("no-policy-tenant", "k8s")).toBe(true);
      expect(await pm.isProviderAllowed("no-policy-tenant", "ec2")).toBe(true);
      expect(await pm.isProviderAllowed("no-policy-tenant", "docker")).toBe(true);
    });

    it("allows only listed providers", async () => {
      await pm.setPolicy({
        tenant_id: "restricted-tenant",
        allowed_providers: ["k8s", "k8s-kata"],
        default_provider: "k8s",
        max_concurrent_sessions: 10,
        max_cost_per_day_usd: null,
        compute_pools: [],
      });

      expect(await pm.isProviderAllowed("restricted-tenant", "k8s")).toBe(true);
      expect(await pm.isProviderAllowed("restricted-tenant", "k8s-kata")).toBe(true);
      expect(await pm.isProviderAllowed("restricted-tenant", "ec2")).toBe(false);
      expect(await pm.isProviderAllowed("restricted-tenant", "docker")).toBe(false);
    });
  });

  describe("canDispatch", async () => {
    it("allows dispatch when under the limit", async () => {
      await pm.setPolicy({
        tenant_id: "can-dispatch-tenant",
        allowed_providers: [],
        default_provider: "k8s",
        max_concurrent_sessions: 10,
        max_cost_per_day_usd: null,
        compute_pools: [],
      });

      const result = await pm.canDispatch("can-dispatch-tenant");
      expect(result.allowed).toBe(true);
      expect(result.reason).toBeUndefined();
    });

    it("allows dispatch for unknown tenant using default policy", async () => {
      const result = await pm.canDispatch("brand-new-tenant");
      expect(result.allowed).toBe(true);
    });
  });
});
