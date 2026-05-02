/**
 * `compute/template/list` RPC — every template row carries both the legacy
 * `provider` name AND the new `compute` + `isolation` axes. The web bundle
 * used to maintain its own provider-map copy to derive the axes from the
 * provider name; the server now does the derivation once (sourced from the
 * canonical `packages/compute/adapters/provider-map.ts`) so the client can
 * read `tmpl.compute` + `tmpl.isolation` directly.
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
  it("returns the two-axis (compute, isolation) pair derived from the legacy provider", async () => {
    // Seed one template per legacy provider family so we exercise every
    // branch of providerToPair.
    const providers: Array<[string, { compute: string; isolation: string }]> = [
      ["local", { compute: "local", isolation: "direct" }],
      ["docker", { compute: "local", isolation: "docker" }],
      ["devcontainer", { compute: "local", isolation: "devcontainer" }],
      ["firecracker", { compute: "local", isolation: "firecracker-in-container" }],
      ["ec2", { compute: "ec2", isolation: "direct" }],
      ["ec2-docker", { compute: "ec2", isolation: "docker" }],
      ["ec2-devcontainer", { compute: "ec2", isolation: "devcontainer" }],
      ["ec2-firecracker", { compute: "ec2", isolation: "firecracker-in-container" }],
      ["k8s", { compute: "k8s", isolation: "direct" }],
      ["k8s-kata", { compute: "k8s-kata", isolation: "direct" }],
    ];

    for (const [prov] of providers) {
      await app.computeTemplates.create({
        name: `tmpl-${prov}`,
        description: `Test template for ${prov}`,
        provider: prov as any,
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

    // Every provider we seeded is present with the expected axes.
    for (const [prov, pair] of providers) {
      const row = templates.find((t) => t.name === `tmpl-${prov}`);
      expect(row).toBeDefined();
      expect(row!.provider).toBe(prov);
      expect(row!.compute).toBe(pair.compute);
      expect(row!.isolation).toBe(pair.isolation);
    }
  });
});
