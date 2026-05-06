/**
 * `compute/capabilities` RPC — returns authoritative capability flags for a
 * named compute target, sourced from the provider instance. Used by the web
 * UI to decide which action buttons to render instead of hardcoding
 * provider-name checks (see P1-1 in
 * docs/2026-04-21-architectural-audit-hardcoded-rules.md).
 *
 * Also covers the tightened guards in `compute/reboot` and `compute/destroy`,
 * which now consult `provider.canReboot` / `provider.canDelete` explicitly
 * instead of relying on method-presence or "throw from destroy" proxies.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { AppContext } from "../../../core/app.js";
import { registerResourceHandlers } from "../resource.js";
import { Router } from "../../router.js";
import { createRequest, ErrorCodes, type JsonRpcResponse, type JsonRpcError } from "../../../protocol/types.js";

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

function err(res: unknown): { code: number; message: string } {
  return (res as JsonRpcError).error as { code: number; message: string };
}

describe("compute/capabilities", () => {
  it("returns the provider-declared flags for the seeded local compute", async () => {
    const res = await router.dispatch(createRequest(1, "compute/capabilities", { name: "local" }));
    const caps = ok(res).capabilities as Record<string, unknown>;

    // LocalWorktreeProvider (registered as "local") declares singleton=true,
    // canReboot=false, canDelete=false, initialStatus="running", and two
    // isolation modes. The handler must read these straight from the
    // provider registry.
    expect(caps.provider).toBe("local");
    expect(caps.singleton).toBe(true);
    expect(caps.canReboot).toBe(false);
    expect(caps.canDelete).toBe(false);
    expect(caps.needsAuth).toBe(false);
    expect(caps.supportsWorktree).toBe(true);
    expect(caps.initialStatus).toBe("running");
    expect(Array.isArray(caps.isolationModes)).toBe(true);
    const modes = caps.isolationModes as Array<{ value: string; label: string }>;
    expect(modes.map((m) => m.value).sort()).toEqual(["inplace", "worktree"]);
  });

  it("returns flags for a docker compute (capabilities inherit from LocalCompute)", async () => {
    // Post-Task-5: capabilities live on Compute, not Isolation. A
    // local+docker row inherits LocalCompute's flags (singleton=true,
    // canDelete=false, initialStatus=running) -- the legacy distinction
    // between local-direct and docker-isolation rows is gone. The wire
    // format still ships a `provider` label derived from the pair so
    // existing UI code keeps rendering, but capability semantics are
    // now uniform per kind.
    await app.computeService.create({
      name: "cap-docker-1",
      compute: "local",
      isolation: "docker",
      is_template: true, // skip the singleton create-time guard for the test
      config: {},
    });

    const res = await router.dispatch(createRequest(2, "compute/capabilities", { name: "cap-docker-1" }));
    const caps = ok(res).capabilities as Record<string, unknown>;

    expect(caps.provider).toBe("docker");
    // Inherits LocalCompute's flags.
    expect(caps.canDelete).toBe(false);
    expect(caps.canReboot).toBe(false);
    expect(caps.singleton).toBe(true);
    expect(caps.initialStatus).toBe("running");

    await app.computes.delete("cap-docker-1");
  });

  it("404s when the compute name is unknown", async () => {
    const res = await router.dispatch(createRequest(3, "compute/capabilities", { name: "no-such-compute" }));
    const e = err(res);
    expect(e.code).toBe(ErrorCodes.NOT_FOUND);
    expect(e.message).toMatch(/no-such-compute/);
  });
});

describe("compute/reboot flag-based guard", () => {
  it("refuses reboot when provider.canReboot is false (local)", async () => {
    const res = await router.dispatch(createRequest(1, "compute/reboot", { name: "local" }));
    const e = err(res);
    expect(e.code).toBe(ErrorCodes.UNSUPPORTED);
    expect(e.message.toLowerCase()).toMatch(/reboot/);
  });
});

describe("compute/destroy flag-based guard", () => {
  it("refuses destroy when provider.canDelete is false (local)", async () => {
    const res = await router.dispatch(createRequest(1, "compute/destroy", { name: "local" }));
    const e = err(res);
    expect(e.code).toBe(ErrorCodes.UNSUPPORTED);
    expect(e.message.toLowerCase()).toMatch(/destroy|delete/);
  });
});
