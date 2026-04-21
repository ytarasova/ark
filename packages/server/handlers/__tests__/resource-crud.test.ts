/**
 * Happy-path + builtin-guard tests for the YAML-aware resource CRUD
 * handlers registered by `resource-crud.ts`. These mirror the CLI paths
 * (`ark agent create/edit/delete/copy`, `ark skill create/delete`,
 * `ark recipe create/delete`) which post a rendered YAML string to the
 * daemon.
 *
 * Resource CRUD is a tenant-member op -- we do NOT gate on `requireAdmin`
 * here (admin-only applies to tenants/teams/users/secrets instead). The
 * tests dispatch without any explicit ctx so the router synthesises the
 * local-admin fallback; asserts that the happy path succeeds and that
 * built-in definitions cannot be overwritten or deleted.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import YAML from "yaml";
import { AppContext } from "../../../core/app.js";
import { registerResourceHandlers } from "../resource.js";
import { registerResourceCrudHandlers } from "../resource-crud.js";
import { Router } from "../../router.js";
import { createRequest, type JsonRpcResponse, type JsonRpcError } from "../../../protocol/types.js";

let app: AppContext;
beforeAll(async () => {
  app = await AppContext.forTestAsync();
  await app.boot();
});
afterAll(async () => {
  await app?.shutdown();
});

let router: Router;

beforeEach(() => {
  router = new Router();
  // Mount the shared resource handlers first (so list/read work), then our
  // YAML-aware variants on top -- matches the real register.ts order.
  registerResourceHandlers(router, app);
  registerResourceCrudHandlers(router, app);
});

function ok(res: unknown): Record<string, unknown> {
  return (res as JsonRpcResponse).result as Record<string, unknown>;
}
function err(res: unknown): { code: number; message: string } {
  return (res as JsonRpcError).error as { code: number; message: string };
}

describe("agent/* yaml CRUD", () => {
  it("agent/create persists a YAML-sourced agent and agent/delete removes it", async () => {
    const yaml = YAML.stringify({
      name: "crud-alpha",
      description: "yaml-path",
      model: "sonnet",
      tools: ["Bash", "Read"],
    });

    const create = await router.dispatch(createRequest(1, "agent/create", { name: "crud-alpha", yaml }));
    expect(ok(create).ok).toBe(true);
    expect(ok(create).name).toBe("crud-alpha");

    const read = await router.dispatch(createRequest(2, "agent/read", { name: "crud-alpha" }));
    const agent = ok(read).agent as { name: string; description: string; tools: string[] };
    expect(agent.name).toBe("crud-alpha");
    expect(agent.description).toBe("yaml-path");
    expect(agent.tools).toContain("Bash");

    const del = await router.dispatch(createRequest(3, "agent/delete", { name: "crud-alpha" }));
    expect(ok(del).ok).toBe(true);
  });

  it("agent/edit overwrites an existing agent's YAML", async () => {
    await router.dispatch(
      createRequest(1, "agent/create", {
        name: "crud-edit",
        yaml: YAML.stringify({ name: "crud-edit", description: "before" }),
      }),
    );
    const edit = await router.dispatch(
      createRequest(2, "agent/edit", {
        name: "crud-edit",
        yaml: YAML.stringify({ name: "crud-edit", description: "after", model: "opus" }),
      }),
    );
    expect(ok(edit).ok).toBe(true);

    const read = await router.dispatch(createRequest(3, "agent/read", { name: "crud-edit" }));
    const agent = ok(read).agent as { description: string; model: string };
    expect(agent.description).toBe("after");
    expect(agent.model).toBe("opus");

    await router.dispatch(createRequest(4, "agent/delete", { name: "crud-edit" }));
  });

  it("agent/edit 404s when the agent doesn't exist", async () => {
    const res = await router.dispatch(
      createRequest(1, "agent/edit", {
        name: "no-such-agent",
        yaml: YAML.stringify({ name: "no-such-agent", description: "x" }),
      }),
    );
    expect(err(res)).toBeDefined();
    expect(err(res).message).toContain("not found");
  });

  it("agent/copy duplicates a builtin under a new name", async () => {
    const copy = await router.dispatch(createRequest(1, "agent/copy", { from: "implementer", to: "crud-copy" }));
    expect(ok(copy).ok).toBe(true);
    expect(ok(copy).name).toBe("crud-copy");

    const read = await router.dispatch(createRequest(2, "agent/read", { name: "crud-copy" }));
    const agent = ok(read).agent as { name: string; _source: string };
    expect(agent.name).toBe("crud-copy");
    expect(agent._source).not.toBe("builtin");

    await router.dispatch(createRequest(3, "agent/delete", { name: "crud-copy" }));
  });

  it("agent/copy rejects identical source + destination names", async () => {
    const res = await router.dispatch(createRequest(1, "agent/copy", { from: "implementer", to: "implementer" }));
    expect(err(res)).toBeDefined();
    expect(err(res).message).toContain("distinct");
  });

  it("agent/create rejects empty name", async () => {
    const res = await router.dispatch(
      createRequest(1, "agent/create", { name: "   ", yaml: YAML.stringify({ name: "anything" }) }),
    );
    expect(err(res)).toBeDefined();
    expect(err(res).message).toMatch(/name/);
  });

  it("agent/create rejects malformed YAML", async () => {
    const res = await router.dispatch(
      createRequest(1, "agent/create", { name: "crud-bad", yaml: "this: is: not: yaml:\n  ::" }),
    );
    expect(err(res)).toBeDefined();
    expect(err(res).message).toMatch(/yaml/i);
  });

  it("agent/delete refuses builtin agents", async () => {
    const res = await router.dispatch(createRequest(1, "agent/delete", { name: "implementer" }));
    expect(err(res)).toBeDefined();
    expect(err(res).message).toContain("builtin");
  });
});

describe("skill/* yaml CRUD", () => {
  it("skill/create persists a YAML-sourced skill and skill/delete removes it", async () => {
    const yaml = YAML.stringify({
      name: "crud-skill",
      description: "test",
      prompt: "do the thing",
      tags: ["a", "b"],
    });
    const create = await router.dispatch(createRequest(1, "skill/create", { name: "crud-skill", yaml }));
    expect(ok(create).ok).toBe(true);

    const list = await router.dispatch(createRequest(2, "skill/list", {}));
    const skills = ok(list).skills as Array<{ name: string }>;
    expect(skills.find((s) => s.name === "crud-skill")).toBeDefined();

    const del = await router.dispatch(createRequest(3, "skill/delete", { name: "crud-skill" }));
    expect(ok(del).ok).toBe(true);
  });

  it("skill/create rejects malformed YAML", async () => {
    const res = await router.dispatch(createRequest(1, "skill/create", { name: "bad", yaml: "{{ not yaml" }));
    expect(err(res)).toBeDefined();
  });

  it("skill/delete refuses builtin skills", async () => {
    const res = await router.dispatch(createRequest(1, "skill/delete", { name: "code-review" }));
    expect(err(res)).toBeDefined();
    expect(err(res).message).toContain("builtin");
  });
});

describe("recipe/* yaml CRUD", () => {
  it("recipe/create persists a YAML-sourced recipe and recipe/delete removes it", async () => {
    const yaml = YAML.stringify({
      name: "crud-recipe",
      description: "test recipe",
      flow: "default",
      variables: [],
    });
    const create = await router.dispatch(createRequest(1, "recipe/create", { name: "crud-recipe", yaml }));
    expect(ok(create).ok).toBe(true);

    const list = await router.dispatch(createRequest(2, "recipe/list", {}));
    const recipes = ok(list).recipes as Array<{ name: string }>;
    expect(recipes.find((r) => r.name === "crud-recipe")).toBeDefined();

    const del = await router.dispatch(createRequest(3, "recipe/delete", { name: "crud-recipe" }));
    expect(ok(del).ok).toBe(true);
  });

  it("recipe/create requires a non-empty flow field", async () => {
    const yaml = YAML.stringify({ name: "no-flow", description: "oops" });
    const res = await router.dispatch(createRequest(1, "recipe/create", { name: "no-flow", yaml }));
    expect(err(res)).toBeDefined();
    expect(err(res).message).toMatch(/flow/);
  });

  it("recipe/delete refuses builtin recipes", async () => {
    const res = await router.dispatch(createRequest(1, "recipe/delete", { name: "quick-fix" }));
    expect(err(res)).toBeDefined();
    expect(err(res).message).toContain("builtin");
  });
});
