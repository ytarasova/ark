/**
 * Tests for pty_cols / pty_rows round-trip on the sessions table.
 *
 * Bug 4 of the session-dispatch cascade: StaticTerminal's auto-detected
 * column count produced mangled replay when the captured stream's
 * cursor-position codes assumed a different width than the browser.
 * The server now pins the tmux PTY geometry at dispatch and persists it
 * on the session row so the frontend can render at the capture width.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { AppContext } from "../app.js";

let app: AppContext;

beforeEach(async () => {
  app = await AppContext.forTestAsync();
  await app.boot();
});

afterEach(async () => {
  await app?.shutdown();
});

describe("pty_cols / pty_rows", () => {
  it("defaults to null on newly created sessions", () => {
    const s = app.sessions.create({ summary: "pty default test" });
    expect(s.pty_cols).toBeNull();
    expect(s.pty_rows).toBeNull();
  });

  it("round-trips pty_cols and pty_rows through update()", () => {
    const s = app.sessions.create({ summary: "pty round-trip test" });
    const updated = app.sessions.update(s.id, { pty_cols: 150, pty_rows: 50 });
    expect(updated?.pty_cols).toBe(150);
    expect(updated?.pty_rows).toBe(50);

    // Re-read to make sure the values survive a fresh SELECT.
    const fetched = app.sessions.get(s.id);
    expect(fetched?.pty_cols).toBe(150);
    expect(fetched?.pty_rows).toBe(50);
  });

  it("accepts updates to pty_cols without clobbering pty_rows (and vice versa)", () => {
    const s = app.sessions.create({ summary: "pty partial update" });
    app.sessions.update(s.id, { pty_cols: 120, pty_rows: 50 });
    app.sessions.update(s.id, { pty_cols: 200 });
    const fetched = app.sessions.get(s.id);
    expect(fetched?.pty_cols).toBe(200);
    expect(fetched?.pty_rows).toBe(50);
  });

  it("tolerates zero / negative via the NULL fallback in rowToSession", () => {
    // rowToSession uses `typeof row.pty_cols === "number"`, so 0 survives
    // the mapper as 0 (we don't want to second-guess; the write path is
    // the validator).
    const s = app.sessions.create({ summary: "pty zero test" });
    app.sessions.update(s.id, { pty_cols: 0, pty_rows: 0 });
    const fetched = app.sessions.get(s.id);
    expect(fetched?.pty_cols).toBe(0);
    expect(fetched?.pty_rows).toBe(0);
  });
});
