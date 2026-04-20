/**
 * LocalCompute unit tests.
 *
 * Verifies the capability surface, arkd URL resolution (reads
 * `app.config.ports.arkd`), and the NotSupportedError surface for snapshot /
 * restore / start / stop / destroy.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";

import { LocalCompute } from "../core/local.js";
import { NotSupportedError, type ComputeHandle, type Snapshot } from "../core/types.js";
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

function makeHandle(): ComputeHandle {
  return { kind: "local", name: "local", meta: {} };
}

describe("LocalCompute", () => {
  it("advertises the expected capability flags", () => {
    const c = new LocalCompute();
    expect(c.kind).toBe("local");
    expect(c.capabilities).toEqual({
      snapshot: false,
      pool: false,
      networkIsolation: false,
      provisionLatency: "instant",
    });
  });

  it("provision is a no-op that mints a handle", async () => {
    const c = new LocalCompute();
    c.setApp(app);
    const h = await c.provision({ tags: { name: "local" } });
    expect(h.kind).toBe("local");
    expect(h.name).toBe("local");
    expect(h.meta).toEqual({});
  });

  it("getArkdUrl reads config.ports.arkd from AppContext", () => {
    const c = new LocalCompute();
    c.setApp(app);
    const expected = `http://localhost:${app.config.ports.arkd}`;
    expect(c.getArkdUrl(makeHandle())).toBe(expected);
  });

  it("getArkdUrl falls back to 19300 when AppContext is absent", () => {
    // Edge case: if an adapter forgets to setApp, we fall back to the
    // documented default instead of crashing with a TypeError.
    const c = new LocalCompute();
    expect(c.getArkdUrl(makeHandle())).toBe("http://localhost:19300");
  });

  it("start throws NotSupportedError", async () => {
    const c = new LocalCompute();
    await expect(c.start(makeHandle())).rejects.toBeInstanceOf(NotSupportedError);
  });

  it("stop throws NotSupportedError", async () => {
    const c = new LocalCompute();
    await expect(c.stop(makeHandle())).rejects.toBeInstanceOf(NotSupportedError);
  });

  it("destroy throws NotSupportedError", async () => {
    const c = new LocalCompute();
    await expect(c.destroy(makeHandle())).rejects.toBeInstanceOf(NotSupportedError);
  });

  it("snapshot throws NotSupportedError", async () => {
    const c = new LocalCompute();
    await expect(c.snapshot(makeHandle())).rejects.toBeInstanceOf(NotSupportedError);
  });

  it("restore throws NotSupportedError", async () => {
    const c = new LocalCompute();
    const snap: Snapshot = {
      id: "noop",
      computeKind: "local",
      createdAt: new Date().toISOString(),
      sizeBytes: 0,
      metadata: {},
    };
    await expect(c.restore(snap)).rejects.toBeInstanceOf(NotSupportedError);
  });
});
