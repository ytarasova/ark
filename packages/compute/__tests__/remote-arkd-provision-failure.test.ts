/**
 * Regression: a provision failure used to write `last_error` + flip status
 * to `stopped`, but emitted no structured log entry. last_error is only
 * readable via `compute show`; operators tailing ~/.ark/ark.jsonl had no
 * signal a compute failed to come up.
 *
 * The catch in RemoteArkdBase.provision now additionally calls
 * `logError("compute", ...)` so the failure lands in the structured log.
 */

import { describe, it, expect, beforeEach, spyOn } from "bun:test";
import { readFileSync, existsSync, writeFileSync } from "fs";
import { join } from "path";
import { setLogLevel } from "../../core/observability/structured-log.js";
import { RemoteWorktreeProvider } from "../providers/remote-arkd.js";
import { withTestContext, getApp } from "../../core/__tests__/test-helpers.js";
import * as ec2Provision from "../providers/ec2/provision.js";

withTestContext();

function readLogEntries(arkDir: string): any[] {
  const logFile = join(arkDir, "ark.jsonl");
  if (!existsSync(logFile)) return [];
  return readFileSync(logFile, "utf-8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

function clearLog(arkDir: string): void {
  const logFile = join(arkDir, "ark.jsonl");
  writeFileSync(logFile, "", "utf-8");
}

describe("RemoteArkdBase.provision failure -> structured logError", () => {
  beforeEach(() => {
    setLogLevel("error");
    clearLog(getApp().config.dirs.ark);
  });

  it("writes a structured logError when provisionStack throws (alongside last_error)", async () => {
    const app = getApp();
    const provider = new RemoteWorktreeProvider();
    provider.app = app;

    // Provider needs a compute row to mergeConfig / update.
    await app.computeService.create({
      name: "remote-prov-fail",
      provider: "ec2" as any,
      config: { region: "us-east-1" } as any,
    });
    const compute = (await app.computes.get("remote-prov-fail"))!;

    // Force provisionStack to throw.
    const provisionSpy = spyOn(ec2Provision, "provisionStack").mockImplementation(async () => {
      throw new Error("synthetic provision failure");
    });

    try {
      await expect(
        provider.provision(compute, { onLog: () => {} } as any),
      ).rejects.toThrow(/synthetic provision failure/);
    } finally {
      provisionSpy.mockRestore();
    }

    // last_error written + status flipped to stopped (existing behavior).
    const updated = await app.computes.get("remote-prov-fail");
    expect(updated?.status).toBe("stopped");
    expect((updated?.config as any)?.last_error).toContain("synthetic provision failure");

    // NEW: structured logError written with the same reason.
    const entries = readLogEntries(app.config.dirs.ark);
    const errorEntry = entries.find(
      (e) => e.level === "error" && e.component === "compute" && String(e.message).includes("provision failed"),
    );
    expect(errorEntry).toBeTruthy();
    expect(errorEntry.data.compute).toBe("remote-prov-fail");
    expect(String(errorEntry.data.error)).toContain("synthetic provision failure");
  });
});
