/**
 * DirectRuntime unit tests.
 *
 * Uses the test-only `setClientFactory` hook to swap in a stub `ArkdClient`
 * so we don't hit the network. The stub records the `launchAgent` payload
 * so we can assert on the exact script / workdir / session name passed
 * through.
 */

import { describe, it, expect } from "bun:test";

import { DirectRuntime } from "../runtimes/direct.js";
import { LocalCompute } from "../core/local.js";
import type { ComputeHandle, LaunchOpts } from "../core/types.js";
import type { ArkdClient } from "../../arkd/client.js";

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
  // LocalCompute's getArkdUrl falls back to :19300 without an app. Good
  // enough -- the stubbed client ignores the URL anyway.
  return new LocalCompute();
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

describe("DirectRuntime", async () => {
  it("has kind=direct and matching name", () => {
    const r = new DirectRuntime();
    expect(r.kind).toBe("direct");
    expect(r.name).toBe("direct");
  });

  it("prepare is a no-op", async () => {
    const r = new DirectRuntime();
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
    const r = new DirectRuntime();
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
    const r = new DirectRuntime();
    r.setClientFactory((url) => {
      urls.push(url);
      return stubClient([]);
    });

    await r.launchAgent(makeCompute(), makeHandle(), opts());

    // Compute with no app falls back to the documented default.
    expect(urls).toEqual(["http://localhost:19300"]);
  });

  it("launchAgent propagates arkd errors", async () => {
    const r = new DirectRuntime();
    r.setClientFactory(() => stubClient(null, new Error("arkd down")));
    (await expect(r.launchAgent(makeCompute(), makeHandle(), opts()))).rejects.toThrow("arkd down");
  });

  it("shutdown is a no-op", async () => {
    const r = new DirectRuntime();
    let called = false;
    r.setClientFactory(() => {
      called = true;
      return stubClient(null);
    });
    await r.shutdown(makeCompute(), makeHandle());
    expect(called).toBe(false);
  });
});
