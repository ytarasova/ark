/**
 * Regression: prepareRemoteEnvironment's syncEnvironment failure used to
 * write `Credential sync failed (continuing): ...` only via the per-launch
 * log callback. That stream is invisible in stuck-at-ready debugging
 * scenarios. Now the failure additionally lands in the structured log
 * (`~/.ark/ark.jsonl`) so operators tailing the JSONL stream see it.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { readFileSync, existsSync, writeFileSync } from "fs";
import { join } from "path";
import { setLogLevel } from "../observability/structured-log.js";
import { prepareRemoteEnvironment } from "../services/agent-launcher.js";
import { withTestContext, getApp } from "./test-helpers.js";
import type { Compute, Session } from "../../types/index.js";
import type { ComputeProvider } from "../../compute/types.js";

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

function makeStubCompute(): Compute {
  return {
    name: "stub-compute",
    provider: "local" as any,
    compute_kind: "local" as any,
    runtime_kind: "direct" as any,
    status: "running",
    config: {} as any, // no instance_id -> SSH/tunnel chain is skipped
    last_used: null,
    last_error: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    tenant_id: null,
  } as Compute;
}

function makeStubProvider(opts: { syncShouldThrow: boolean }): ComputeProvider {
  return {
    name: "stub",
    supportsWorktree: false,
    async start() {},
    async stop() {},
    async destroy() {},
    async status() {
      return "running" as const;
    },
    async syncEnvironment() {
      if (opts.syncShouldThrow) {
        throw new Error("synthetic syncEnvironment failure");
      }
    },
    async launch() {
      return "stub-handle";
    },
    async killAgent() {},
    async captureOutput() {
      return "";
    },
    buildChannelConfig() {
      return {};
    },
  } as unknown as ComputeProvider;
}

describe("prepareRemoteEnvironment syncEnvironment failure", () => {
  beforeEach(() => {
    setLogLevel("error");
    clearLog(getApp().config.dirs.ark);
  });

  it("writes a structured logError when syncEnvironment throws (continues, doesn't rethrow)", async () => {
    const app = getApp();
    const session: Session = await app.sessions.create({ summary: "sync failure test", flow: "bare" });
    const compute = makeStubCompute();
    const provider = makeStubProvider({ syncShouldThrow: true });

    // Should NOT throw -- syncEnvironment failure is best-effort.
    await prepareRemoteEnvironment(app, session, compute, provider, "" /* no workdir */, {
      onLog: () => {},
    });

    const entries = readLogEntries(app.config.dirs.ark);
    const errorEntry = entries.find(
      (e) => e.level === "error" && String(e.message).includes("syncEnvironment failed"),
    );
    expect(errorEntry).toBeTruthy();
    expect(errorEntry.component).toBe("session");
    expect(errorEntry.data.sessionId).toBe(session.id);
    expect(errorEntry.data.compute).toBe("stub-compute");
    expect(String(errorEntry.data.error)).toContain("synthetic syncEnvironment failure");
  });

  it("does NOT write a structured error when syncEnvironment succeeds", async () => {
    const app = getApp();
    const session: Session = await app.sessions.create({ summary: "sync success test", flow: "bare" });
    const compute = makeStubCompute();
    const provider = makeStubProvider({ syncShouldThrow: false });

    await prepareRemoteEnvironment(app, session, compute, provider, "", { onLog: () => {} });

    const entries = readLogEntries(app.config.dirs.ark);
    const errorEntry = entries.find(
      (e) => e.level === "error" && String(e.message).includes("syncEnvironment failed"),
    );
    expect(errorEntry).toBeFalsy();
  });
});
