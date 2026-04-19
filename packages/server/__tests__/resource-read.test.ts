import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { AppContext, setApp, clearApp } from "../../core/app.js";
import { registerResourceHandlers } from "../handlers/resource.js";
import { Router } from "../router.js";
import { createRequest, type JsonRpcResponse, type JsonRpcError } from "../../protocol/types.js";

let app: AppContext;
beforeAll(async () => {
  app = await AppContext.forTestAsync();
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

describe("agent/read", () => {
  it("returns a builtin agent by name", async () => {
    const agents = ok(await router.dispatch(createRequest(1, "agent/list", {})));
    const first = (agents.agents as Array<{ name: string }>)[0];
    expect(first).toBeDefined();

    const res = await router.dispatch(createRequest(2, "agent/read", { name: first.name }));
    const agent = ok(res).agent as Record<string, unknown>;
    expect(agent.name).toBe(first.name);
  });

  it("returns error for unknown agent", async () => {
    const res = await router.dispatch(createRequest(1, "agent/read", { name: "nonexistent-agent-xyz" }));
    expect(err(res)).toBeDefined();
    expect(err(res).message).toContain("not found");
  });
});

describe("flow/read", () => {
  it("returns a builtin flow by name", async () => {
    const flows = ok(await router.dispatch(createRequest(1, "flow/list", {})));
    const first = (flows.flows as Array<{ name: string }>)[0];
    expect(first).toBeDefined();

    const res = await router.dispatch(createRequest(2, "flow/read", { name: first.name }));
    const flow = ok(res).flow as Record<string, unknown>;
    expect(flow.name).toBe(first.name);
  });

  it("returns error for unknown flow", async () => {
    const res = await router.dispatch(createRequest(1, "flow/read", { name: "nonexistent-flow-xyz" }));
    expect(err(res)).toBeDefined();
    expect(err(res).message).toContain("not found");
  });
});

describe("skill/read", () => {
  it("returns a builtin skill by name", async () => {
    const skills = ok(await router.dispatch(createRequest(1, "skill/list", {})));
    const first = (skills.skills as Array<{ name: string }>)[0];
    expect(first).toBeDefined();

    const res = await router.dispatch(createRequest(2, "skill/read", { name: first.name }));
    const skill = ok(res).skill as Record<string, unknown>;
    expect(skill).toBeDefined();
    expect((skill as Record<string, unknown>).name).toBe(first.name);
  });

  it("returns null-ish for unknown skill", async () => {
    const res = await router.dispatch(createRequest(1, "skill/read", { name: "nonexistent-skill-xyz" }));
    const result = ok(res);
    expect(result.skill).toBeFalsy();
  });
});

describe("runtime/read", () => {
  it("returns a builtin runtime by name", async () => {
    const runtimes = ok(await router.dispatch(createRequest(1, "runtime/list", {})));
    const first = (runtimes.runtimes as Array<{ name: string }>)[0];
    expect(first).toBeDefined();

    const res = await router.dispatch(createRequest(2, "runtime/read", { name: first.name }));
    const runtime = ok(res).runtime as Record<string, unknown>;
    expect(runtime.name).toBe(first.name);
  });

  it("returns error for unknown runtime", async () => {
    const res = await router.dispatch(createRequest(1, "runtime/read", { name: "nonexistent-runtime-xyz" }));
    expect(err(res)).toBeDefined();
    expect(err(res).message).toContain("not found");
  });
});

describe("recipe/read", () => {
  it("returns a builtin recipe by name", async () => {
    const recipes = ok(await router.dispatch(createRequest(1, "recipe/list", {})));
    const first = (recipes.recipes as Array<{ name: string }>)[0];
    expect(first).toBeDefined();

    const res = await router.dispatch(createRequest(2, "recipe/read", { name: first.name }));
    const recipe = ok(res).recipe as Record<string, unknown>;
    expect(recipe.name).toBe(first.name);
  });

  it("returns error for unknown recipe", async () => {
    const res = await router.dispatch(createRequest(1, "recipe/read", { name: "nonexistent-recipe-xyz" }));
    expect(err(res)).toBeDefined();
    expect(err(res).message).toContain("not found");
  });
});

describe("compute/read", () => {
  it("reads the seeded local compute target", async () => {
    const listRes = await router.dispatch(createRequest(1, "compute/list", {}));
    const targets = ok(listRes).targets as Array<{ name: string }>;
    expect(targets.length).toBeGreaterThan(0);

    const res = await router.dispatch(createRequest(2, "compute/read", { name: targets[0].name }));
    const compute = ok(res).compute as Record<string, unknown>;
    expect(compute.name).toBe(targets[0].name);
  });

  it("returns error for unknown compute", async () => {
    const res = await router.dispatch(createRequest(1, "compute/read", { name: "nonexistent-compute-xyz" }));
    expect(err(res)).toBeDefined();
    expect(err(res).message).toContain("not found");
  });
});

describe("compute/kinds and runtime/kinds", () => {
  it("compute/kinds returns a non-empty list", async () => {
    const res = await router.dispatch(createRequest(1, "compute/kinds", {}));
    const kinds = ok(res).kinds as unknown[];
    expect(kinds.length).toBeGreaterThan(0);
  });

  it("runtime/kinds returns a non-empty list", async () => {
    const res = await router.dispatch(createRequest(1, "runtime/kinds", {}));
    const kinds = ok(res).kinds as unknown[];
    expect(kinds.length).toBeGreaterThan(0);
  });
});

describe("group/list", () => {
  it("returns groups array", async () => {
    const res = await router.dispatch(createRequest(1, "group/list", {}));
    const groups = ok(res).groups;
    expect(Array.isArray(groups)).toBe(true);
  });
});
