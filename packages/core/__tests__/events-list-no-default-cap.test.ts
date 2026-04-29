/**
 * `app.events.list(sessionId)` (no explicit limit) must return the full event
 * log for that session.
 *
 * Pre-fix the repository defaulted to `limit: 200`, which silently truncated:
 *   - session/read in the server, so the web UI lost any events past #200
 *     and rendered Pre/PostToolUse-paired tools as stuck "running" when the
 *     Post landed in the dropped tail.
 *   - knowledge/evals, conductor /events, task-builder context, share
 *     exports, handoff retry counts -- every caller that wanted "all events
 *     for this session" without thinking about pagination.
 *
 * Real incident: PAI-31995 dispatch on the staging box. The child session
 * had 320 events. UI fetched 200, so 3 Bash blocks rendered as RUNNING
 * forever even though the Posts were on disk and the session was completed.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { AppContext } from "../app.js";

let app: AppContext;

beforeAll(async () => {
  app = await AppContext.forTestAsync();
  await app.boot();
});

afterAll(async () => {
  await app?.shutdown();
}, 30_000);

describe("events.list -- no default truncation cap", () => {
  it("returns ALL events for a session (>200) when no limit is passed", async () => {
    const session = await app.sessions.create({ summary: "events-no-cap test", flow: "bare" });

    const N = 350;
    for (let i = 0; i < N; i++) {
      await app.events.log(session.id, "synthetic", { actor: "test", data: { i } });
    }

    const events = await app.events.list(session.id);
    expect(events.length).toBe(N);
  });

  it("still respects an explicit limit when one is passed", async () => {
    const session = await app.sessions.create({ summary: "events-explicit-limit test", flow: "bare" });

    for (let i = 0; i < 50; i++) {
      await app.events.log(session.id, "synthetic", { actor: "test", data: { i } });
    }

    const events = await app.events.list(session.id, { limit: 10 });
    expect(events.length).toBe(10);
  });

  it("preserves Pre/PostToolUse pairing across what would have been the old 200-event boundary", async () => {
    // The exact pathology from the incident: a tool's Pre at event 199 and
    // its Post at event 201 used to land on opposite sides of the truncation
    // and look orphaned to the UI.
    const session = await app.sessions.create({ summary: "pre-post boundary test", flow: "bare" });

    // Pad to push the Pre/Post pair past index 200.
    for (let i = 0; i < 199; i++) {
      await app.events.log(session.id, "padding", { actor: "test", data: { i } });
    }
    await app.events.log(session.id, "hook_status", {
      actor: "hook",
      data: { event: "PreToolUse", tool_name: "Bash", tool_use_id: "toolu_split" },
    });
    for (let i = 0; i < 50; i++) {
      await app.events.log(session.id, "padding", { actor: "test", data: { i: 200 + i } });
    }
    await app.events.log(session.id, "hook_status", {
      actor: "hook",
      data: { event: "PostToolUse", tool_use_id: "toolu_split", is_error: false, tool_result_content: "ok" },
    });

    const events = await app.events.list(session.id);
    const pre = events.find((e) => (e.data as Record<string, unknown> | null)?.event === "PreToolUse");
    const post = events.find((e) => (e.data as Record<string, unknown> | null)?.event === "PostToolUse");
    expect(pre).toBeDefined();
    expect(post).toBeDefined();
    expect((pre!.data as Record<string, unknown>).tool_use_id).toBe("toolu_split");
    expect((post!.data as Record<string, unknown>).tool_use_id).toBe("toolu_split");
  });
});
