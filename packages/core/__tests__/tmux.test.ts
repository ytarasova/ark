/**
 * Tests for tmux.ts -- pure/deterministic helpers.
 *
 * Covers: hasTmux, attachCommand, writeLauncher, sessionExists, listArkSessionsAsync.
 * Skips functions that create/kill real tmux sessions (covered by E2E tests).
 */

import { describe, it, expect } from "bun:test";
import { existsSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { hasTmux, attachCommand, writeLauncher, sessionExists, listArkSessionsAsync } from "../infra/tmux.js";
import { withTestContext } from "./test-helpers.js";
import { getApp } from "./test-helpers.js";

withTestContext();

// ── hasTmux ──────────────────────────────────────────────────────────────────

describe("hasTmux", () => {
  it("returns true on dev machines with tmux installed", () => {
    expect(hasTmux()).toBe(true);
  });
});

// ── attachCommand ────────────────────────────────────────────────────────────

describe("attachCommand", () => {
  it("returns local tmux attach for any session name", () => {
    expect(attachCommand("ark-session-1")).toBe("tmux attach -t ark-session-1");
  });

  it("returns local tmux attach for short-form session names", () => {
    expect(attachCommand("s-abc")).toBe("tmux attach -t s-abc");
  });

  // Remote-compute attaches go through `provider.getAttachCommand(compute,
  // session)` now (aws ssm start-session for EC2, kubectl exec for k8s).
  // The old ssh-prefixed branch on this helper went away with the SSH-to-SSM
  // transport migration; nothing in production code passed `host` anymore.
});

// ── writeLauncher ────────────────────────────────────────────────────────────

describe("writeLauncher", () => {
  const testContent = "#!/bin/bash\necho hello\n";

  it("creates launch.sh and returns its path", () => {
    const testSessionId = `test-launcher-${Date.now()}`;
    const path = writeLauncher(testSessionId, testContent, getApp().config.dirs.tracks);

    expect(path).toBe(join(getApp().config.dirs.tracks, testSessionId, "launch.sh"));
    expect(existsSync(path)).toBe(true);
  });

  it("file content matches the input", () => {
    const sessionId = `test-content-${Date.now()}`;
    const content = "#!/bin/bash\nset -e\ncd /app && npm start\n";
    const path = writeLauncher(sessionId, content, getApp().config.dirs.tracks);

    const written = readFileSync(path, "utf-8");
    expect(written).toBe(content);
  });

  it("creates parent directory if it does not exist", () => {
    const sessionId = `test-mkdir-${Date.now()}`;
    const dir = join(getApp().config.dirs.tracks, sessionId);
    expect(existsSync(dir)).toBe(false);

    writeLauncher(sessionId, "#!/bin/bash\n", getApp().config.dirs.tracks);

    expect(existsSync(dir)).toBe(true);
  });

  it("sets executable permissions (755)", () => {
    const sessionId = `test-perms-${Date.now()}`;
    const path = writeLauncher(sessionId, "#!/bin/bash\n", getApp().config.dirs.tracks);

    const mode = statSync(path).mode & 0o777;
    expect(mode).toBe(0o755);
  });
});

// ── sessionExists ────────────────────────────────────────────────────────────

describe("sessionExists", () => {
  it("returns false for a non-existent session", () => {
    expect(sessionExists("__nonexistent_session_xyz__")).toBe(false);
  });
});

// ── listArkSessionsAsync ─────────────────────────────────────────────────────────

describe("listArkSessionsAsync", async () => {
  it("returns an array", async () => {
    const sessions = await listArkSessionsAsync();
    expect(Array.isArray(sessions)).toBe(true);
  });

  it("only includes sessions with ark- or s- prefix", async () => {
    const sessions = await listArkSessionsAsync();
    for (const s of sessions) {
      expect(s.name.startsWith("ark-") || s.name.startsWith("s-")).toBe(true);
    }
  });

  it("each session has name and alive fields", async () => {
    const sessions = await listArkSessionsAsync();
    for (const s of sessions) {
      expect(typeof s.name).toBe("string");
      expect(s.alive).toBe(true);
    }
  });
});
