/**
 * Verifies the agent/flow/skill/recipe CRUD RPC handlers added by the surface
 * parity audit. Before this commit, Web `Create Flow`/`Create Agent`/`New Skill`
 * forms called these methods but they were never registered, so every click
 * silently 404'd at -32601.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { AppContext, setApp, clearApp } from "../../core/app.js";
import { registerResourceHandlers } from "../handlers/resource.js";
import { Router } from "../router.js";
import { createRequest, type JsonRpcResponse, type JsonRpcError } from "../../protocol/types.js";

let app: AppContext;
beforeAll(async () => {
  app = AppContext.forTest();
  setApp(app);
  await app.boot();
});
afterAll(async () => {
  await app?.shutdown();
  clearApp();
});

let router: Router;

beforeEach(() => {
  router = new Router();
  registerResourceHandlers(router, app);
});

function ok(res: unknown): Record<string, unknown> {
  return (res as JsonRpcResponse).result as Record<string, unknown>;
}

function err(res: unknown): { code: number; message: string } {
  return (res as JsonRpcError).error as { code: number; message: string };
}

describe("agent CRUD handlers", () => {
  it("agent/create persists a new agent and agent/delete removes it", async () => {
    const create = await router.dispatch(createRequest(1, "agent/create", {
      name: "parity-agent",
      description: "test",
      model: "sonnet",
      tools: ["Bash", "Read"],
    }));
    expect(ok(create).ok).toBe(true);
    expect(ok(create).name).toBe("parity-agent");

    const list = await router.dispatch(createRequest(2, "agent/list", {}));
    const agents = ok(list).agents as Array<{ name: string }>;
    expect(agents.find(a => a.name === "parity-agent")).toBeDefined();

    const del = await router.dispatch(createRequest(3, "agent/delete", { name: "parity-agent" }));
    expect(ok(del).ok).toBe(true);
  });

  it("agent/update merges fields", async () => {
    await router.dispatch(createRequest(1, "agent/create", { name: "parity-update", description: "first" }));
    const update = await router.dispatch(createRequest(2, "agent/update", { name: "parity-update", description: "second" }));
    expect(ok(update).ok).toBe(true);

    const read = await router.dispatch(createRequest(3, "agent/read", { name: "parity-update" }));
    expect((ok(read).agent as { description: string }).description).toBe("second");

    await router.dispatch(createRequest(4, "agent/delete", { name: "parity-update" }));
  });

  it("agent/delete refuses builtin agents", async () => {
    // 'implementer' is a built-in agent shipped in agents/
    const res = await router.dispatch(createRequest(1, "agent/delete", { name: "implementer" }));
    expect(err(res)).toBeDefined();
    expect(err(res).message).toContain("builtin");
  });
});

describe("flow CRUD handlers", () => {
  it("flow/create persists a flow and flow/delete removes it", async () => {
    const stages = [
      { name: "plan", agent: "spec-planner", gate: "manual" },
      { name: "implement", agent: "implementer", gate: "auto" },
    ];
    const create = await router.dispatch(createRequest(1, "flow/create", {
      name: "parity-flow",
      description: "test",
      stages,
    }));
    expect(ok(create).ok).toBe(true);
    expect(ok(create).name).toBe("parity-flow");

    const list = await router.dispatch(createRequest(2, "flow/list", {}));
    const flows = ok(list).flows as Array<{ name: string }>;
    expect(flows.find(f => f.name === "parity-flow")).toBeDefined();

    const del = await router.dispatch(createRequest(3, "flow/delete", { name: "parity-flow" }));
    expect(ok(del).ok).toBe(true);
  });

  it("flow/create rejects empty stages", async () => {
    const res = await router.dispatch(createRequest(1, "flow/create", { name: "empty", stages: [] }));
    expect(err(res)).toBeDefined();
    expect(err(res).message).toContain("at least one stage");
  });

  it("flow/delete refuses builtin flows", async () => {
    const res = await router.dispatch(createRequest(1, "flow/delete", { name: "default" }));
    expect(err(res)).toBeDefined();
    expect(err(res).message).toContain("builtin");
  });
});

describe("skill CRUD handlers", () => {
  it("skill/save creates and skill/delete removes", async () => {
    const save = await router.dispatch(createRequest(1, "skill/save", {
      name: "parity-skill",
      description: "test skill",
      prompt: "Do the thing.",
      tags: ["test"],
    }));
    expect(ok(save).ok).toBe(true);

    const list = await router.dispatch(createRequest(2, "skill/list", {}));
    const skills = ok(list).skills as Array<{ name: string }>;
    expect(skills.find(s => s.name === "parity-skill")).toBeDefined();

    const del = await router.dispatch(createRequest(3, "skill/delete", { name: "parity-skill" }));
    expect(ok(del).ok).toBe(true);
  });

  it("skill/delete refuses builtin skills", async () => {
    const res = await router.dispatch(createRequest(1, "skill/delete", { name: "code-review" }));
    expect(err(res)).toBeDefined();
    expect(err(res).message).toContain("builtin");
  });
});

describe("recipe CRUD handlers", () => {
  it("recipe/delete refuses builtin recipes", async () => {
    const res = await router.dispatch(createRequest(1, "recipe/delete", { name: "quick-fix" }));
    expect(err(res)).toBeDefined();
    expect(err(res).message).toContain("builtin");
  });
});
