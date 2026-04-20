/**
 * Tests for the PTY geometry sentinel written by the terminal bridge.
 *
 * The sentinel (`$ARK_SESSION_DIR/geometry`) unblocks the claude launcher
 * so the first render matches the real client viewport. On the first
 * resize the bridge also persists pty_cols / pty_rows on the session row
 * so the replay (StaticTerminal) renders at the same width.
 */

import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { writeGeometrySentinel } from "../hosted/terminal-bridge.js";

function tmpSessionDir(): string {
  return mkdtempSync(join(tmpdir(), "ark-geom-"));
}

describe("writeGeometrySentinel", () => {
  it("writes `<cols> <rows>` terminated by a newline", () => {
    const dir = tmpSessionDir();
    writeGeometrySentinel(dir, 180, 42);
    const content = readFileSync(join(dir, "geometry"), "utf-8");
    expect(content).toBe("180 42\n");
  });

  it("creates the session directory if it does not yet exist", () => {
    const base = tmpSessionDir();
    const nested = join(base, "deep", "nested");
    writeGeometrySentinel(nested, 80, 24);
    expect(existsSync(join(nested, "geometry"))).toBe(true);
    expect(readFileSync(join(nested, "geometry"), "utf-8")).toBe("80 24\n");
  });

  it("writes atomically via tmp + rename (no partial file visible)", () => {
    // This test is a smoke check: writing twice should leave a complete
    // second value. If the write were non-atomic, a crashed writer could
    // leave a half-flushed geometry line behind.
    const dir = tmpSessionDir();
    writeGeometrySentinel(dir, 80, 24);
    writeGeometrySentinel(dir, 200, 60);
    expect(readFileSync(join(dir, "geometry"), "utf-8")).toBe("200 60\n");
  });

  it("floors non-integer dimensions (xterm.js sometimes reports fractions)", () => {
    const dir = tmpSessionDir();
    writeGeometrySentinel(dir, 120.7, 40.9);
    expect(readFileSync(join(dir, "geometry"), "utf-8")).toBe("120 40\n");
  });

  it("is a no-op when cols/rows are invalid (non-finite or zero)", () => {
    const dir = tmpSessionDir();
    writeGeometrySentinel(dir, 0, 24);
    expect(existsSync(join(dir, "geometry"))).toBe(false);

    writeGeometrySentinel(dir, 120, -1);
    expect(existsSync(join(dir, "geometry"))).toBe(false);

    writeGeometrySentinel(dir, Number.NaN, 50);
    expect(existsSync(join(dir, "geometry"))).toBe(false);
  });

  it("overwrites a stale sentinel from a prior bridge (reconnect case)", () => {
    // Reconnects after a crash + relaunch should end up with the newest
    // geometry, not a carry-over from a previous session. The launcher
    // only reads the file once anyway, so this is mostly defensive.
    const dir = tmpSessionDir();
    writeFileSync(join(dir, "geometry"), "999 999\n");
    writeGeometrySentinel(dir, 144, 48);
    expect(readFileSync(join(dir, "geometry"), "utf-8")).toBe("144 48\n");
  });
});
