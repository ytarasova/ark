/**
 * Tests for the exit-code sentinel path in status-poller.ts.
 *
 * Bug 3 of the session-dispatch cascade: when claude exits non-zero the
 * launcher's `exec bash` keeps tmux alive, so the standard poller thinks
 * the session is still running. The sentinel file ($ARK_SESSION_DIR/exit-code)
 * is the authoritative failure signal.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { AppContext } from "../app.js";
import { readExitCodeSentinel, startStatusPoller, stopAllPollers } from "../executors/status-poller.js";
import * as tmux from "../infra/tmux.js";

let app: AppContext;

beforeEach(async () => {
  app = await AppContext.forTestAsync();
  await app.boot();
});

afterEach(async () => {
  stopAllPollers();
  await app?.shutdown();
});

function waitFor(fn: () => boolean, timeoutMs = 10000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (fn()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error("waitFor timed out"));
      setTimeout(check, 100);
    };
    check();
  });
}

// ── readExitCodeSentinel ────────────────────────────────────────────────────

describe("readExitCodeSentinel", () => {
  it("returns null when the session directory does not exist", () => {
    expect(readExitCodeSentinel(app.config.tracksDir, "s-missing")).toBeNull();
  });

  it("returns null when the file is empty", () => {
    const dir = join(app.config.tracksDir, "s-empty");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "exit-code"), "");
    expect(readExitCodeSentinel(app.config.tracksDir, "s-empty")).toBeNull();
  });

  it("returns null when the code is 0 (success)", () => {
    const dir = join(app.config.tracksDir, "s-zero");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "exit-code"), "0\n");
    expect(readExitCodeSentinel(app.config.tracksDir, "s-zero")).toBeNull();
  });

  it("returns the numeric exit code when non-zero", () => {
    const dir = join(app.config.tracksDir, "s-err");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "exit-code"), "42\n");
    expect(readExitCodeSentinel(app.config.tracksDir, "s-err")).toBe(42);
  });

  it("tolerates a trailing newline / whitespace", () => {
    const dir = join(app.config.tracksDir, "s-ws");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "exit-code"), "  7  \n");
    expect(readExitCodeSentinel(app.config.tracksDir, "s-ws")).toBe(7);
  });

  it("returns null when the file content is non-numeric garbage", () => {
    const dir = join(app.config.tracksDir, "s-junk");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "exit-code"), "oops\n");
    expect(readExitCodeSentinel(app.config.tracksDir, "s-junk")).toBeNull();
  });
});

// ── Poller + sentinel integration ────────────────────────────────────────────

describe("status-poller with exit-code sentinel", () => {
  it("flips the session to failed when a non-zero sentinel exists", async () => {
    const session = app.sessions.create({ summary: "sentinel-failed test", flow: "autonomous" });
    const handle = "ark-" + session.id;
    app.sessions.update(session.id, {
      status: "running",
      stage: "work",
      session_id: handle,
    });

    // Write the sentinel BEFORE starting the poller. tmux reports "alive".
    const dir = join(app.config.tracksDir, session.id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "exit-code"), "1\n");

    const spy = spyOn(tmux, "sessionExistsAsync").mockResolvedValue(true);

    try {
      startStatusPoller(app, session.id, handle, "claude-code");

      await waitFor(() => {
        const s = app.sessions.get(session.id);
        return s?.status === "failed";
      });

      const updated = app.sessions.get(session.id);
      expect(updated?.status).toBe("failed");
      expect(updated?.error).toContain("exited with code 1");
      expect(updated?.session_id).toBeNull();

      const events = app.events.list(session.id);
      const failed = events.find((e) => e.type === "session_failed");
      expect(failed).not.toBeUndefined();
      const data = typeof failed!.data === "string" ? JSON.parse(failed!.data) : failed!.data;
      expect(data.exitCode).toBe(1);
      expect(data.reason).toBe("agent exit-code sentinel");
    } finally {
      spy.mockRestore();
    }
  });

  it("happy path: no sentinel, tmux alive, session stays running", async () => {
    const session = app.sessions.create({ summary: "sentinel-happy test", flow: "autonomous" });
    const handle = "ark-" + session.id;
    app.sessions.update(session.id, {
      status: "running",
      stage: "work",
      session_id: handle,
    });

    // No sentinel file on disk, tmux reports "alive".
    const spy = spyOn(tmux, "sessionExistsAsync").mockResolvedValue(true);

    try {
      startStatusPoller(app, session.id, handle, "claude-code");
      await Bun.sleep(150);
      const s = app.sessions.get(session.id);
      expect(s?.status).toBe("running");
    } finally {
      spy.mockRestore();
    }
  });

  it("sentinel value of 0 is ignored (not treated as failure)", async () => {
    const session = app.sessions.create({ summary: "sentinel-zero test", flow: "autonomous" });
    const handle = "ark-" + session.id;
    app.sessions.update(session.id, {
      status: "running",
      stage: "work",
      session_id: handle,
    });

    const dir = join(app.config.tracksDir, session.id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "exit-code"), "0\n");

    const spy = spyOn(tmux, "sessionExistsAsync").mockResolvedValue(true);

    try {
      startStatusPoller(app, session.id, handle, "claude-code");
      await Bun.sleep(150);
      const s = app.sessions.get(session.id);
      expect(s?.status).toBe("running");
    } finally {
      spy.mockRestore();
    }
  });
});
