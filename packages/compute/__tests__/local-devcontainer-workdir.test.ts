/**
 * F5 regression: LocalDevcontainerProvider.provision must NOT fall back to
 * `process.cwd()` when `cfg.workdir` is unset. Pre-fix, the daemon's cwd at
 * provision time silently leaked into the devcontainer config row and every
 * later session inherited it -- non-deterministic, hard to debug.
 *
 * Fix: throw a clear error rather than guess. `start` mirrors `provision`.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";

import { LocalDevcontainerProvider } from "../providers/local-arkd.js";
import type { Compute } from "../types.js";
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

function makeCompute(overrides?: Partial<Compute>): Compute {
  return {
    name: "test-devcontainer-f5",
    provider: "devcontainer",
    status: "stopped",
    config: {},
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  } as Compute;
}

describe("LocalDevcontainerProvider.provision (F5)", () => {
  it("throws a clear error when cfg.workdir is undefined (no process.cwd() fallback)", async () => {
    const provider = new LocalDevcontainerProvider(app);

    let error: Error | null = null;
    try {
      await provider.provision(makeCompute());
    } catch (e) {
      error = e as Error;
    }
    expect(error).not.toBeNull();
    expect(error!.message).toContain("no `workdir`");
    // The error message must NOT mention any /Users/... or process.cwd()
    // result -- if it does, the fallback regressed.
    expect(error!.message.includes("/Users/")).toBe(false);
    expect(error!.message.includes("/private/")).toBe(false);
  });

  it("throws when cfg.workdir is the empty string (treated as unset)", async () => {
    const provider = new LocalDevcontainerProvider(app);
    let error: Error | null = null;
    try {
      await provider.provision(makeCompute({ name: "test-dc-f5-empty", config: { workdir: "" } }));
    } catch (e) {
      error = e as Error;
    }
    expect(error).not.toBeNull();
    expect(error!.message).toContain("no `workdir`");
  });
});

describe("LocalDevcontainerProvider.start (F5)", () => {
  it("throws when cfg.workdir is missing (corrupt row)", async () => {
    const provider = new LocalDevcontainerProvider(app);
    let error: Error | null = null;
    try {
      await provider.start(makeCompute({ name: "test-dc-f5-start", config: {} }));
    } catch (e) {
      error = e as Error;
    }
    expect(error).not.toBeNull();
    expect(error!.message).toContain("no `workdir`");
    expect(error!.message.includes("/Users/")).toBe(false);
  });
});
