/**
 * Tests for exec.ts — posix_spawnp + waitpid wrapper.
 * Integration-style: spawns real processes.
 */

import { describe, it, expect } from "bun:test";
import { spawnAndWait } from "../exec.js";

describe("spawnAndWait", () => {
  it("returns 0 for successful command", () => {
    expect(spawnAndWait("true", [])).toBe(0);
  });

  it("returns 1 for failing command", () => {
    expect(spawnAndWait("false", [])).toBe(1);
  });

  it("passes arguments to the command", () => {
    expect(spawnAndWait("echo", ["hello", "world"])).toBe(0);
  });

  it("throws for non-existent command", () => {
    expect(() => spawnAndWait("__nonexistent_command_xyz__", [])).toThrow();
  });
});
