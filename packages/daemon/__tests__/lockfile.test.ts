/**
 * Tests for daemon lockfile management.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  writeLockfile, readLockfile, removeLockfile, isDaemonRunning,
  lockfilePath, type DaemonInfo,
} from "../lockfile.js";

describe("lockfile", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "ark-lockfile-test-"));
  });

  afterEach(() => {
    try { removeLockfile(tempDir); } catch { /* cleanup best-effort */ }
  });

  const sampleInfo: DaemonInfo = {
    pid: process.pid,
    ws_url: "ws://127.0.0.1:19400",
    conductor_port: 19100,
    arkd_port: 19300,
    started_at: new Date().toISOString(),
  };

  it("lockfilePath returns correct path", () => {
    expect(lockfilePath(tempDir)).toBe(join(tempDir, "daemon.json"));
  });

  it("write/read round-trip preserves data", () => {
    writeLockfile(tempDir, sampleInfo);
    const read = readLockfile(tempDir);
    expect(read).toEqual(sampleInfo);
  });

  it("write with web_port preserves optional field", () => {
    const info = { ...sampleInfo, web_port: 8420 };
    writeLockfile(tempDir, info);
    const read = readLockfile(tempDir);
    expect(read!.web_port).toBe(8420);
  });

  it("readLockfile returns null for missing file", () => {
    expect(readLockfile(tempDir)).toBeNull();
  });

  it("readLockfile returns null for corrupted JSON", () => {
    writeFileSync(lockfilePath(tempDir), "not valid json{{{");
    expect(readLockfile(tempDir)).toBeNull();
  });

  it("readLockfile returns null for missing required fields", () => {
    writeFileSync(lockfilePath(tempDir), JSON.stringify({ pid: 1 }));
    expect(readLockfile(tempDir)).toBeNull();
  });

  it("removeLockfile deletes the file", () => {
    writeLockfile(tempDir, sampleInfo);
    expect(existsSync(lockfilePath(tempDir))).toBe(true);
    removeLockfile(tempDir);
    expect(existsSync(lockfilePath(tempDir))).toBe(false);
  });

  it("removeLockfile is safe on missing file", () => {
    // Should not throw
    removeLockfile(tempDir);
  });

  describe("isDaemonRunning", () => {
    it("returns false when no lockfile exists", () => {
      expect(isDaemonRunning(tempDir)).toEqual({ running: false });
    });

    it("returns true when lockfile exists and pid is alive (current process)", () => {
      writeLockfile(tempDir, sampleInfo);
      const result = isDaemonRunning(tempDir);
      expect(result.running).toBe(true);
      expect(result.info).toEqual(sampleInfo);
    });

    it("returns false and cleans up stale lockfile (dead pid)", () => {
      // Use a pid that almost certainly doesn't exist
      const staleInfo = { ...sampleInfo, pid: 2147483647 };
      writeLockfile(tempDir, staleInfo);
      expect(existsSync(lockfilePath(tempDir))).toBe(true);

      const result = isDaemonRunning(tempDir);
      expect(result.running).toBe(false);
      // Stale lockfile should have been cleaned up
      expect(existsSync(lockfilePath(tempDir))).toBe(false);
    });
  });
});
