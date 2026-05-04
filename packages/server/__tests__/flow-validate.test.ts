/**
 * RPC handler tests for `flow/validate` (#403).
 *
 * Covers the dry-run behaviour: inline + named flows, requires_repo gating,
 * declared-inputs contract, and the "no session created" invariant (the
 * handler must never write to sessions or the ephemeral flow overlay).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { AppContext } from "../../core/app.js";
import { registerResourceHandlers } from "../handlers/resource.js";
import { Router } from "../router.js";
import { createRequest, type JsonRpcResponse } from "../../protocol/types.js";

let app: AppContext;
let router: Router;

beforeAll(async () => {
  app = await AppContext.forTestAsync();
  await app.boot();
});

afterAll(async () => {
  await app?.shutdown();
});

beforeEach(() => {
  router = new Router();
  registerResourceHandlers(router, app);
});

function result(res: unknown): Record<string, unknown> {
  return (res as JsonRpcResponse).result as Record<string, unknown>;
}

describe("flow/validate handler", () => {
  it("accepts a valid inline flow and returns ok=true with stage echo", async () => {
    const res = await router.dispatch(
      createRequest(1, "flow/validate", {
        flow: {
          name: "my-flow",
          stages: [
            { name: "plan", agent: "planner", gate: "auto" },
            { name: "impl", agent: "implementer", gate: "auto" },
          ],
        },
      }),
    );
    const r = result(res);
    expect(r.ok).toBe(true);
    expect(r.problems).toEqual([]);
    expect((r.flow as Record<string, unknown>).name).toBe("my-flow");
    expect((r.flow as Record<string, unknown>).stages).toEqual(["plan", "impl"]);
  });

  it("reports a cycle in the DAG", async () => {
    const res = await router.dispatch(
      createRequest(2, "flow/validate", {
        flow: {
          name: "cyclic",
          stages: [
            { name: "a", agent: "x", gate: "auto", depends_on: ["b"] },
            { name: "b", agent: "x", gate: "auto", depends_on: ["a"] },
          ],
        },
      }),
    );
    const r = result(res);
    expect(r.ok).toBe(false);
    expect((r.problems as string[]).some((p) => /cycle/i.test(p))).toBe(true);
  });

  it("reports an unknown depends_on reference", async () => {
    const res = await router.dispatch(
      createRequest(3, "flow/validate", {
        flow: {
          name: "bad-deps",
          stages: [
            { name: "a", agent: "x", gate: "auto" },
            { name: "b", agent: "x", gate: "auto", depends_on: ["ghost"] },
          ],
        },
      }),
    );
    const r = result(res);
    expect(r.ok).toBe(false);
    expect((r.problems as string[]).some((p) => p.includes("ghost"))).toBe(true);
  });

  it("rejects an inline flow with zero stages via the Zod schema", async () => {
    // Zod `min(1)` fires before our handler, so this arrives as a structured
    // JSON-RPC error, not a `problems` entry.
    const res = await router.dispatch(
      createRequest(4, "flow/validate", {
        flow: { name: "empty", stages: [] },
      }),
    );
    const body = res as Record<string, unknown>;
    expect(body.error ?? body.result).toBeDefined();
    // Either is acceptable -- the contract is "don't claim ok=true".
    if (body.error) {
      expect((body.error as { code: number }).code).toBeLessThan(0);
    } else {
      expect((body.result as { ok: boolean }).ok).toBe(false);
    }
  });

  it("reports missing required input (flat-bag declaration)", async () => {
    const res = await router.dispatch(
      createRequest(5, "flow/validate", {
        flow: {
          name: "requires-ticket",
          stages: [{ name: "s", agent: "a", gate: "auto" }],
          inputs: { ticket_id: { type: "string", required: true } },
        },
      }),
    );
    const r = result(res);
    expect(r.ok).toBe(false);
    expect((r.problems as string[]).some((p) => p.includes("ticket_id"))).toBe(true);
  });

  it("accepts required input when supplied via inputs bag", async () => {
    const res = await router.dispatch(
      createRequest(6, "flow/validate", {
        flow: {
          name: "requires-ticket",
          stages: [{ name: "s", agent: "a", gate: "auto" }],
          inputs: { ticket_id: { type: "string", required: true } },
        },
        inputs: { ticket_id: "ABC-123" },
      }),
    );
    const r = result(res);
    expect(r.ok).toBe(true);
  });

  it("returns a problem (not a crash) for unknown named flow", async () => {
    const res = await router.dispatch(createRequest(7, "flow/validate", { flow: "nonexistent-flow-for-test-403" }));
    const r = result(res);
    expect(r.ok).toBe(false);
    expect((r.problems as string[]).some((p) => p.includes("not found"))).toBe(true);
  });

  it("validates a named registered flow from the FlowStore", async () => {
    // `bare` is shipped as a builtin and does not declare requires_repo, so
    // a dry-run without a repo is expected to succeed.
    const res = await router.dispatch(createRequest(8, "flow/validate", { flow: "bare" }));
    const r = result(res);
    expect(r.ok).toBe(true);
    expect((r.flow as Record<string, unknown>).name).toBe("bare");
  });

  it("does not create a session or register an ephemeral flow", async () => {
    const before = (await app.sessions.list()).length;
    const inline = {
      name: "ephemeral-check",
      stages: [{ name: "s", agent: "a", gate: "auto" }],
    };
    await router.dispatch(createRequest(9, "flow/validate", { flow: inline }));
    const after = (await app.sessions.list()).length;
    expect(after).toBe(before);
    // Validate should not register the flow under its own name (or any
    // `inline-*` key we can observe) -- the overlay stays empty for this name.
    expect(app.flows.get("ephemeral-check")).toBeNull();
  });

  it("gates requires_repo: true on a named flow without a repo", async () => {
    // `default` ships with requires_repo: true (see flows/definitions/default.yaml).
    const withoutRepo = await router.dispatch(createRequest(10, "flow/validate", { flow: "default" }));
    const a = result(withoutRepo);
    expect(a.ok).toBe(false);
    expect((a.problems as string[]).some((p) => /requires a repo/i.test(p))).toBe(true);

    const withRepo = await router.dispatch(
      createRequest(11, "flow/validate", { flow: "default", repo: "/tmp/fake-repo" }),
    );
    const b = result(withRepo);
    // The requires_repo problem should be gone; there may still be other
    // problems from the builtin flow (unknown agents in test profile etc.),
    // but the specific "requires a repo" message should not appear.
    expect((b.problems as string[]).some((p) => /requires a repo/i.test(p))).toBe(false);
  });
});
