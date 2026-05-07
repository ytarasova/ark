/**
 * DirectIsolation unit tests.
 *
 * Uses the test-only `setClientFactory` hook to swap in a stub `ArkdClient`
 * so we don't hit the network. The stub records the `launchAgent` payload
 * so we can assert on the exact script / workdir / session name passed
 * through.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";

import { DirectIsolation } from "../isolation/direct.js";
import { LocalCompute } from "../local.js";
import type { ComputeHandle, LaunchOpts } from "../types.js";
import type { ArkdClient } from "../../../arkd/client/index.js";
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

type LaunchCall = {
  sessionName: string;
  script: string;
  workdir: string;
};

function stubClient(record: LaunchCall[] | null, throwOnLaunch?: Error): ArkdClient {
  const client = {
    launchAgent: async (req: { sessionName: string; script: string; workdir: string }) => {
      if (throwOnLaunch) throw throwOnLaunch;
      record?.push({ sessionName: req.sessionName, script: req.script, workdir: req.workdir });
      return { ok: true } as unknown as never;
    },
  } as unknown as ArkdClient;
  return client;
}

function makeCompute(): LocalCompute {
  // The stubbed ArkdClient factory ignores the URL the compute hands back,
  // so we only need a valid AppContext on the compute to keep the type
  // check honest.
  return new LocalCompute(app);
}

function makeHandle(): ComputeHandle {
  return { kind: "local", name: "local", meta: {} };
}

function opts(): LaunchOpts {
  return {
    tmuxName: "ark-s-test",
    workdir: "/tmp/work",
    launcherContent: "#!/bin/bash\necho hello",
  };
}

describe("DirectIsolation", async () => {
  it("has kind=direct and matching name", () => {
    const r = new DirectIsolation(app);
    expect(r.kind).toBe("direct");
    expect(r.name).toBe("direct");
  });

  it("prepare is a no-op", async () => {
    const r = new DirectIsolation(app);
    // Must not throw, must not call arkd.
    let called = false;
    r.setClientFactory(() => {
      called = true;
      return stubClient(null);
    });
    await r.prepare(makeCompute(), makeHandle(), { workdir: "/tmp" });
    expect(called).toBe(false);
  });

  it("launchAgent forwards sessionName, script, workdir to arkd", async () => {
    const calls: LaunchCall[] = [];
    const r = new DirectIsolation(app);
    r.setClientFactory(() => stubClient(calls));

    const handle = await r.launchAgent(makeCompute(), makeHandle(), opts());

    expect(handle.sessionName).toBe("ark-s-test");
    expect(calls.length).toBe(1);
    expect(calls[0]).toEqual({
      sessionName: "ark-s-test",
      script: "#!/bin/bash\necho hello",
      workdir: "/tmp/work",
    });
  });

  it("launchAgent resolves the arkd URL via Compute.getArkdUrl", async () => {
    const urls: string[] = [];
    const r = new DirectIsolation(app);
    r.setClientFactory((url) => {
      urls.push(url);
      return stubClient([]);
    });

    await r.launchAgent(makeCompute(), makeHandle(), opts());

    // LocalCompute.getArkdUrl reads app.config.ports.arkd.
    expect(urls).toEqual([`http://localhost:${app.config.ports.arkd}`]);
  });

  it("launchAgent propagates arkd errors", async () => {
    const r = new DirectIsolation(app);
    r.setClientFactory(() => stubClient(null, new Error("arkd down")));
    (await expect(r.launchAgent(makeCompute(), makeHandle(), opts()))).rejects.toThrow("arkd down");
  });

  it("shutdown is a no-op", async () => {
    const r = new DirectIsolation(app);
    let called = false;
    r.setClientFactory(() => {
      called = true;
      return stubClient(null);
    });
    await r.shutdown(makeCompute(), makeHandle());
    expect(called).toBe(false);
  });
});
