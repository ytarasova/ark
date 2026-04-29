/**
 * Regression test: session.create must persist every top-level input.
 *
 * Pre-fix, SessionLifecycle.start filtered `opts.inputs` down to just
 * `files` and `params`, silently dropping any other top-level key. With
 * the flat-bag inputs schema, flows declare arbitrary input names like
 * `targets`, `repos`, or `ticket_id` -- losing those made every
 * `{{inputs.<key>}}` lookup in the dispatched flow resolve to undefined
 * and the for_each resolver threw "Cannot resolve for_each list".
 *
 * This test dispatches no agent; it only verifies the persisted
 * `session.config.inputs` shape.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { AppContext } from "../app.js";

let app: AppContext;
beforeAll(async () => {
  app = await AppContext.forTestAsync();
  await app.boot();
});
afterAll(async () => {
  await app?.shutdown();
});

describe("session.create: flat inputs bag passthrough", () => {
  it("persists arbitrary top-level input keys verbatim", async () => {
    const session = await app.sessionLifecycle.start({
      summary: "inputs passthrough",
      flow: "bare",
      inputs: {
        ticket_id: "SMOKE-1",
        targets: [{ path: "foo.txt", content: "hello" }],
        analysis_json: { $type: "blob", locator: "ark://blob/abc" },
      },
    });

    const row = await app.sessions.get(session.id);
    const cfg = row?.config as { inputs?: Record<string, unknown> } | null;
    expect(cfg?.inputs).toBeDefined();
    expect(cfg!.inputs!.ticket_id).toBe("SMOKE-1");
    expect(cfg!.inputs!.targets).toEqual([{ path: "foo.txt", content: "hello" }]);
    expect(cfg!.inputs!.analysis_json).toEqual({ $type: "blob", locator: "ark://blob/abc" });
  });

  it("legacy nested shape still round-trips unchanged (no key rewriting)", async () => {
    // Older callers that still send {files, params} should see their data
    // land at the same path. We don't upgrade the shape on write.
    const session = await app.sessionLifecycle.start({
      summary: "legacy nested",
      flow: "bare",
      inputs: {
        files: { recipe: "/abs/rec.yaml" } as any,
        params: { jira_key: "IN-1" } as any,
      },
    });

    const row = await app.sessions.get(session.id);
    const cfg = row?.config as { inputs?: Record<string, unknown> } | null;
    expect(cfg?.inputs).toBeDefined();
    expect(cfg!.inputs!.files).toEqual({ recipe: "/abs/rec.yaml" });
    expect(cfg!.inputs!.params).toEqual({ jira_key: "IN-1" });
  });

  it("omits config.inputs entirely when no inputs are passed", async () => {
    const session = await app.sessionLifecycle.start({
      summary: "no inputs",
      flow: "bare",
    });

    const row = await app.sessions.get(session.id);
    const cfg = row?.config as { inputs?: Record<string, unknown> } | null;
    expect(cfg?.inputs).toBeUndefined();
  });
});
