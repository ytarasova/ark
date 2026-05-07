/**
 * LocalCompute unit tests.
 *
 * Verifies the capability surface, arkd URL resolution (reads
 * `app.config.ports.arkd`), and the NotSupportedError surface for snapshot /
 * restore / start / stop / destroy.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";

import { LocalCompute } from "../local.js";
import { NotSupportedError, type ComputeHandle, type Snapshot } from "../types.js";
import { AppContext } from "../../app.js";
import { setApp, clearApp } from "../../__tests__/test-helpers.js";

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

function makeHandle(): ComputeHandle {
  return { kind: "local", name: "local", meta: {} };
}

describe("LocalCompute", async () => {
  it("advertises the expected capability flags", () => {
    const c = new LocalCompute(app);
    expect(c.kind).toBe("local");
    expect(c.capabilities).toEqual({
      snapshot: false,
      pool: false,
      networkIsolation: false,
      provisionLatency: "instant",
      singleton: true,
      canDelete: false,
      canReboot: false,
      supportsWorktree: true,
      supportsSecretMount: false,
      needsAuth: false,
      initialStatus: "running",
      isolationModes: [
        { value: "worktree", label: "Worktree" },
        { value: "inplace", label: "In-place" },
      ],
    });
  });

  it("provision is a no-op that mints a handle", async () => {
    const c = new LocalCompute(app);
    const h = await c.provision({ tags: { name: "local" } });
    expect(h.kind).toBe("local");
    expect(h.name).toBe("local");
    expect(h.meta).toEqual({});
  });

  it("getArkdUrl reads config.ports.arkd from AppContext", () => {
    const c = new LocalCompute(app);
    const expected = `http://localhost:${app.config.ports.arkd}`;
    expect(c.getArkdUrl(makeHandle())).toBe(expected);
  });

  it("start throws NotSupportedError", async () => {
    const c = new LocalCompute(app);
    (await expect(c.start(makeHandle()))).rejects.toBeInstanceOf(NotSupportedError);
  });

  it("stop throws NotSupportedError", async () => {
    const c = new LocalCompute(app);
    (await expect(c.stop(makeHandle()))).rejects.toBeInstanceOf(NotSupportedError);
  });

  it("destroy throws NotSupportedError", async () => {
    const c = new LocalCompute(app);
    (await expect(c.destroy(makeHandle()))).rejects.toBeInstanceOf(NotSupportedError);
  });

  it("snapshot throws NotSupportedError", async () => {
    const c = new LocalCompute(app);
    (await expect(c.snapshot(makeHandle()))).rejects.toBeInstanceOf(NotSupportedError);
  });

  it("restore throws NotSupportedError", async () => {
    const c = new LocalCompute(app);
    const snap: Snapshot = {
      id: "noop",
      computeKind: "local",
      createdAt: new Date().toISOString(),
      sizeBytes: 0,
      metadata: {},
    };
    (await expect(c.restore(snap))).rejects.toBeInstanceOf(NotSupportedError);
  });
});
