/**
 * Wave 3: compute/create RPC accepts both the legacy `{provider}` form and
 * the new `{compute, runtime}` form. Both paths must persist both the legacy
 * `provider` column and the new `compute_kind` / `runtime_kind` columns so
 * back-compat reads keep working.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { AppContext, setApp, clearApp } from "../../core/app.js";
import { Router } from "../router.js";
import { registerResourceHandlers } from "../handlers/resource.js";

let app: AppContext;
let router: Router;

beforeAll(async () => {
  app = AppContext.forTest();
  await app.boot();
  setApp(app);
  router = new Router();
  registerResourceHandlers(router, app);
});

afterAll(async () => {
  await app?.shutdown();
  clearApp();
});

beforeEach(() => {
  // Clean out everything except the seeded `local` row.
  for (const c of app.computes.list()) {
    if (c.name !== "local") app.computes.delete(c.name);
  }
});

async function call(method: string, params: Record<string, unknown>): Promise<any> {
  const result = await router.dispatch({ jsonrpc: "2.0", id: 1, method, params });
  if ((result as any).error) throw new Error((result as any).error.message);
  return (result as any).result;
}

describe("compute/create (Wave 3 two-axis form)", () => {
  it("accepts legacy {provider} and backfills compute_kind + runtime_kind", async () => {
    const { compute } = await call("compute/create", {
      name: "legacy-docker",
      provider: "docker",
      config: {},
    });
    expect(compute.name).toBe("legacy-docker");
    expect(compute.provider).toBe("docker");
    expect(compute.compute_kind).toBe("local");
    expect(compute.runtime_kind).toBe("docker");
  });

  it("accepts new {compute, runtime} and persists both axes + legacy provider", async () => {
    const { compute } = await call("compute/create", {
      name: "new-form-docker",
      compute: "local",
      runtime: "docker",
      config: {},
    });
    expect(compute.compute_kind).toBe("local");
    expect(compute.runtime_kind).toBe("docker");
    // Server reverse-maps to a legacy provider name for back-compat.
    expect(compute.provider).toBe("docker");
  });

  it("accepts new {compute, runtime} for ec2 + devcontainer", async () => {
    const { compute } = await call("compute/create", {
      name: "new-form-ec2-dc",
      compute: "ec2",
      runtime: "devcontainer",
      config: { region: "us-east-1" },
    });
    expect(compute.compute_kind).toBe("ec2");
    expect(compute.runtime_kind).toBe("devcontainer");
    expect(compute.provider).toBe("ec2-devcontainer");
  });

  it("compute/read returns both axes + legacy provider", async () => {
    await call("compute/create", {
      name: "read-test",
      compute: "ec2",
      runtime: "docker",
      config: {},
    });
    const { compute } = await call("compute/read", { name: "read-test" });
    expect(compute.provider).toBeTruthy();
    expect(compute.compute_kind).toBe("ec2");
    expect(compute.runtime_kind).toBe("docker");
  });

  it("compute/kinds returns the registered compute list", async () => {
    const res = await call("compute/kinds", {});
    expect(Array.isArray(res.kinds)).toBe(true);
    expect(res.kinds).toContain("local");
  });

  it("runtime/kinds returns the registered runtime list", async () => {
    const res = await call("runtime/kinds", {});
    expect(Array.isArray(res.kinds)).toBe(true);
    expect(res.kinds).toContain("direct");
    expect(res.kinds).toContain("docker");
  });
});
