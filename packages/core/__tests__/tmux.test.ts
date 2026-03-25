/**
 * Tests for tmux.ts — pure/deterministic helpers.
 *
 * Covers: hasTmux, attachCommand, writeLauncher, sessionExists, listArkSessionsAsync.
 * Skips functions that create/kill real tmux sessions (covered by E2E tests).
 */

import { describe, it, expect, afterAll } from "bun:test";
import { existsSync, readFileSync, statSync, rmSync } from "fs";
import { join } from "path";
import {
  hasTmux,
  attachCommand,
  writeLauncher,
  sessionExists,
  listArkSessionsAsync,
} from "../tmux.js";
import { TRACKS_DIR } from "../store.js";

// Track directories created by writeLauncher for cleanup
const createdDirs: string[] = [];

afterAll(() => {
  for (const dir of createdDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

// ── hasTmux ──────────────────────────────────────────────────────────────────

describe("hasTmux", () => {
  it("returns true on dev machines with tmux installed", () => {
    expect(hasTmux()).toBe(true);
  });
});

// ── attachCommand ────────────────────────────────────────────────────────────

describe("attachCommand", () => {
  it("returns local tmux attach when no host is provided", () => {
    expect(attachCommand("ark-session-1")).toBe("tmux attach -t ark-session-1");
  });

  it("returns local tmux attach when opts is empty", () => {
    expect(attachCommand("s-abc", {})).toBe("tmux attach -t s-abc");
  });

  it("returns ssh + tmux for remote host", () => {
    const cmd = attachCommand("ark-remote", { host: "10.0.0.1" });
    expect(cmd).toBe("ssh -t ubuntu@10.0.0.1 tmux attach -t ark-remote");
  });

  it("defaults remote user to ubuntu", () => {
    const cmd = attachCommand("s-1", { host: "myhost.dev" });
    expect(cmd).toContain("ubuntu@myhost.dev");
  });

  it("uses custom user when provided", () => {
    const cmd = attachCommand("s-1", { host: "myhost.dev", user: "admin" });
    expect(cmd).toBe("ssh -t admin@myhost.dev tmux attach -t s-1");
    expect(cmd).not.toContain("ubuntu");
  });

  it("includes -i flag for SSH key", () => {
    const cmd = attachCommand("s-1", {
      host: "myhost.dev",
      sshKey: "/home/user/.ssh/my-key.pem",
    });
    expect(cmd).toBe(
      "ssh -i /home/user/.ssh/my-key.pem -t ubuntu@myhost.dev tmux attach -t s-1"
    );
  });

  it("combines SSH key and custom user", () => {
    const cmd = attachCommand("s-1", {
      host: "ec2.aws.com",
      user: "ec2-user",
      sshKey: "/keys/id_rsa",
    });
    expect(cmd).toBe(
      "ssh -i /keys/id_rsa -t ec2-user@ec2.aws.com tmux attach -t s-1"
    );
  });

  it("ignores sshKey and user when host is not set", () => {
    const cmd = attachCommand("local-sess", { sshKey: "/key", user: "root" });
    expect(cmd).toBe("tmux attach -t local-sess");
  });
});

// ── writeLauncher ────────────────────────────────────────────────────────────

describe("writeLauncher", () => {
  const testSessionId = `test-launcher-${Date.now()}`;
  const testContent = "#!/bin/bash\necho hello\n";

  afterAll(() => {
    // Cleanup handled by top-level afterAll via createdDirs
  });

  it("creates launch.sh and returns its path", () => {
    const path = writeLauncher(testSessionId, testContent);
    createdDirs.push(join(TRACKS_DIR(), testSessionId));

    expect(path).toBe(join(TRACKS_DIR(), testSessionId, "launch.sh"));
    expect(existsSync(path)).toBe(true);
  });

  it("file content matches the input", () => {
    const sessionId = `test-content-${Date.now()}`;
    const content = "#!/bin/bash\nset -e\ncd /app && npm start\n";
    const path = writeLauncher(sessionId, content);
    createdDirs.push(join(TRACKS_DIR(), sessionId));

    const written = readFileSync(path, "utf-8");
    expect(written).toBe(content);
  });

  it("creates parent directory if it does not exist", () => {
    const sessionId = `test-mkdir-${Date.now()}`;
    const dir = join(TRACKS_DIR(), sessionId);
    expect(existsSync(dir)).toBe(false);

    writeLauncher(sessionId, "#!/bin/bash\n");
    createdDirs.push(dir);

    expect(existsSync(dir)).toBe(true);
  });

  it("sets executable permissions (755)", () => {
    const sessionId = `test-perms-${Date.now()}`;
    const path = writeLauncher(sessionId, "#!/bin/bash\n");
    createdDirs.push(join(TRACKS_DIR(), sessionId));

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

describe("listArkSessionsAsync", () => {
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
