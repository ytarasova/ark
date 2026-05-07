/**
 * `compute/template/list` RPC -- every template row carries the new
 * `compute` + `isolation` axes (and a synthesized legacy `provider` name
 * for back-compat readers). The web bundle used to maintain its own
 * provider-map copy to derive the axes; the server now does the derivation
 * once so the client can read `tmpl.compute` + `tmpl.isolation` directly.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { AppContext } from "../../../core/app.js";
import { registerResourceHandlers } from "../resource.js";
import { Router } from "../../router.js";
import { createRequest, type JsonRpcResponse } from "../../../protocol/types.js";

let app: AppContext;
let router: Router;

beforeAll(async () => {
  app = await AppContext.forTestAsync();
  await app.boot();
  router = new Router();
  registerResourceHandlers(router, app);
});

afterAll(async () => {
  await app?.shutdown();
});

function ok(res: unknown): Record<string, unknown> {
  return (res as JsonRpcResponse).result as Record<string, unknown>;
}

describe("compute/template/list", () => {
  it("returns the two-axis (compute, isolation) pair plus the legacy provider label", async () => {
    // Seed one template per supported (compute, isolation) pair. The wire
    // format keeps a legacy `provider` string for back-compat clients,
    // derived from the pair via `legacyProviderLabel`.
    type Row = { compute: string; isolation: string; provider: string };
    const rows: Row[] = [
      { compute: "local", isolation: "direct", provider: "local" },
      { compute: "local", isolation: "docker", provider: "docker" },
      { compute: "local", isolation: "devcontainer", provider: "devcontainer" },
      { compute: "ec2", isolation: "direct", provider: "ec2" },
      { compute: "ec2", isolation: "docker", provider: "ec2-docker" },
      { compute: "ec2", isolation: "devcontainer", provider: "ec2-devcontainer" },
      { compute: "firecracker", isolation: "direct", provider: "firecracker" },
      { compute: "k8s", isolation: "direct", provider: "k8s" },
      { compute: "k8s-kata", isolation: "direct", provider: "k8s-kata" },
    ];

    for (const r of rows) {
      await app.computeTemplates.create({
        name: `tmpl-${r.provider}`,
        description: `Test template for ${r.provider}`,
        compute: r.compute as any,
        isolation: r.isolation as any,
        config: {},
      });
    }

    const res = await router.dispatch(createRequest(1, "compute/template/list", {}));
    const templates = ok(res).templates as Array<Record<string, unknown>>;

    // Every entry carries `compute` + `isolation`.
    for (const t of templates) {
      expect(typeof t.compute).toBe("string");
      expect(typeof t.isolation).toBe("string");
    }

    // Every (compute, isolation) row we seeded is present with the expected axes.
    for (const r of rows) {
      const row = templates.find((t) => t.name === `tmpl-${r.provider}`);
      expect(row).toBeDefined();
      expect(row!.provider).toBe(r.provider);
      expect(row!.compute).toBe(r.compute);
      expect(row!.isolation).toBe(r.isolation);
    }
  });
});
