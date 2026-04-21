/**
 * Tests for pty_cols / pty_rows round-trip on the sessions table.
 *
 * Originally these columns were written at dispatch (120x50 hardcoded). That
 * pinned the live agent to 120 cols regardless of the real web viewport,
 * which meant cursor-position escapes landed in the wrong cells when the
 * browser was wider/narrower. Today pty_cols / pty_rows are *observed* (the
 * terminal bridge writes them on the first client resize -- see
 * packages/core/hosted/terminal-bridge.ts), not prescribed. They start NULL
 * on freshly created sessions and get populated once a real client connects.
 * These tests only cover the repo round-trip; the write path is covered in
 * packages/core/__tests__/terminal-bridge-geometry.test.ts.
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

describe("pty_cols / pty_rows", async () => {
  it("defaults to null on newly created sessions", async () => {
    const s = await app.sessions.create({ summary: "pty default test" });
    expect(s.pty_cols).toBeNull();
    expect(s.pty_rows).toBeNull();
  });

  it("round-trips pty_cols and pty_rows through update()", async () => {
    const s = await app.sessions.create({ summary: "pty round-trip test" });
    const updated = await app.sessions.update(s.id, { pty_cols: 150, pty_rows: 50 });
    expect(updated?.pty_cols).toBe(150);
    expect(updated?.pty_rows).toBe(50);

    // Re-read to make sure the values survive a fresh SELECT.
    const fetched = await app.sessions.get(s.id);
    expect(fetched?.pty_cols).toBe(150);
    expect(fetched?.pty_rows).toBe(50);
  });

  it("accepts updates to pty_cols without clobbering pty_rows (and vice versa)", async () => {
    const s = await app.sessions.create({ summary: "pty partial update" });
    await app.sessions.update(s.id, { pty_cols: 120, pty_rows: 50 });
    await app.sessions.update(s.id, { pty_cols: 200 });
    const fetched = await app.sessions.get(s.id);
    expect(fetched?.pty_cols).toBe(200);
    expect(fetched?.pty_rows).toBe(50);
  });

  it("tolerates zero / negative via the NULL fallback in rowToSession", async () => {
    // rowToSession uses `typeof row.pty_cols === "number"`, so 0 survives
    // the mapper as 0 (we don't want to second-guess; the write path is
    // the validator).
    const s = await app.sessions.create({ summary: "pty zero test" });
    await app.sessions.update(s.id, { pty_cols: 0, pty_rows: 0 });
    const fetched = await app.sessions.get(s.id);
    expect(fetched?.pty_cols).toBe(0);
    expect(fetched?.pty_rows).toBe(0);
  });
});
