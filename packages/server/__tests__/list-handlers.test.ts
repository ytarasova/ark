import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { AppContext, setApp, clearApp } from "../../core/app.js";
import { registerSessionHandlers } from "../handlers/session.js";
import { registerResourceHandlers } from "../handlers/resource.js";
import { Router } from "../router.js";
import { createRequest, type JsonRpcResponse } from "../../protocol/types.js";

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
  registerSessionHandlers(router, app);
  registerResourceHandlers(router, app);
});

function ok(res: unknown): Record<string, unknown> {
  return (res as JsonRpcResponse).result as Record<string, unknown>;
}

// ── Session list ────────────────────────────────────────────────────────────

describe("session/list", () => {
  it("returns an array of sessions", async () => {
    await router.dispatch(createRequest(1, "session/start", { summary: "list-a", repo: ".", flow: "bare" }));
    await router.dispatch(createRequest(2, "session/start", { summary: "list-b", repo: ".", flow: "bare" }));
    const res = ok(await router.dispatch(createRequest(3, "session/list", {})));
    const sessions = res.sessions as Array<{ summary: string }>;
    expect(sessions.length).toBeGreaterThanOrEqual(2);
    expect(sessions.some((s) => s.summary === "list-a")).toBe(true);
    expect(sessions.some((s) => s.summary === "list-b")).toBe(true);
  });

  it("filters by status", async () => {
    await router.dispatch(createRequest(1, "session/start", { summary: "status-filter", repo: ".", flow: "bare" }));
    const res = ok(await router.dispatch(createRequest(2, "session/list", { status: "pending" })));
    const sessions = res.sessions as Array<{ status: string }>;
    for (const s of sessions) {
      expect(s.status).toBe("pending");
    }
  });

  it("filters by repo", async () => {
    await router.dispatch(
      createRequest(1, "session/start", { summary: "repo-filter", repo: "/tmp/test-repo", flow: "bare" }),
    );
    const res = ok(await router.dispatch(createRequest(2, "session/list", { repo: "/tmp/test-repo" })));
    const sessions = res.sessions as Array<{ repo: string }>;
    expect(sessions.length).toBeGreaterThanOrEqual(1);
    for (const s of sessions) {
      expect(s.repo).toBe("/tmp/test-repo");
    }
  });

  it("filters by flow", async () => {
    await router.dispatch(createRequest(1, "session/start", { summary: "flow-filter", repo: ".", flow: "bare" }));
    const res = ok(await router.dispatch(createRequest(2, "session/list", { flow: "bare" })));
    const sessions = res.sessions as Array<{ flow: string }>;
    expect(sessions.length).toBeGreaterThanOrEqual(1);
    for (const s of sessions) {
      expect(s.flow).toBe("bare");
    }
  });

  it("respects limit", async () => {
    await router.dispatch(createRequest(1, "session/start", { summary: "lim-1", repo: ".", flow: "bare" }));
    await router.dispatch(createRequest(2, "session/start", { summary: "lim-2", repo: ".", flow: "bare" }));
    const res = ok(await router.dispatch(createRequest(3, "session/list", { limit: 1 })));
    const sessions = res.sessions as unknown[];
    expect(sessions.length).toBe(1);
  });

  it("returns empty array when no sessions match filter", async () => {
    const res = ok(await router.dispatch(createRequest(1, "session/list", { repo: "/nonexistent/repo/xyz" })));
    const sessions = res.sessions as unknown[];
    expect(sessions).toEqual([]);
  });
});

// ── Resource list handlers ──────────────────────────────────────────────────

describe("agent/list", () => {
  it("returns builtin agents", async () => {
    const res = ok(await router.dispatch(createRequest(1, "agent/list", {})));
    const agents = res.agents as Array<{ name: string; _source: string }>;
    expect(agents.length).toBeGreaterThan(0);
    expect(agents.some((a) => a._source === "builtin")).toBe(true);
  });

  it("each agent has required fields", async () => {
    const res = ok(await router.dispatch(createRequest(1, "agent/list", {})));
    const agents = res.agents as Array<Record<string, unknown>>;
    for (const a of agents) {
      expect(a.name).toBeDefined();
      expect(a.model).toBeDefined();
      expect(Array.isArray(a.tools)).toBe(true);
    }
  });
});

describe("flow/list", () => {
  it("returns builtin flows", async () => {
    const res = ok(await router.dispatch(createRequest(1, "flow/list", {})));
    const flows = res.flows as Array<{ name: string }>;
    expect(flows.length).toBeGreaterThan(0);
  });

  it("each flow has name and stages", async () => {
    const res = ok(await router.dispatch(createRequest(1, "flow/list", {})));
    const flows = res.flows as Array<Record<string, unknown>>;
    for (const f of flows) {
      expect(f.name).toBeDefined();
      expect(f.stages).toBeDefined();
    }
  });
});

describe("skill/list", () => {
  it("returns builtin skills", async () => {
    const res = ok(await router.dispatch(createRequest(1, "skill/list", {})));
    const skills = res.skills as Array<{ name: string }>;
    expect(skills.length).toBeGreaterThan(0);
    expect(skills.some((s) => s.name === "code-review")).toBe(true);
  });
});

describe("recipe/list", () => {
  it("returns builtin recipes", async () => {
    const res = ok(await router.dispatch(createRequest(1, "recipe/list", {})));
    const recipes = res.recipes as Array<{ name: string }>;
    expect(recipes.length).toBeGreaterThan(0);
    expect(recipes.some((r) => r.name === "quick-fix")).toBe(true);
  });
});

describe("runtime/list", () => {
  it("returns available runtimes", async () => {
    const res = ok(await router.dispatch(createRequest(1, "runtime/list", {})));
    const runtimes = res.runtimes as Array<{ name: string; type: string }>;
    expect(runtimes.length).toBeGreaterThan(0);
  });

  it("each runtime has name and type", async () => {
    const res = ok(await router.dispatch(createRequest(1, "runtime/list", {})));
    const runtimes = res.runtimes as Array<Record<string, unknown>>;
    for (const r of runtimes) {
      expect(r.name).toBeDefined();
      expect(r.type).toBeDefined();
    }
  });
});

describe("compute/list", () => {
  it("returns compute targets", async () => {
    const res = ok(await router.dispatch(createRequest(1, "compute/list", {})));
    const targets = res.targets as unknown[];
    expect(Array.isArray(targets)).toBe(true);
  });

  it("includes the auto-created local compute", async () => {
    const res = ok(await router.dispatch(createRequest(1, "compute/list", {})));
    const targets = res.targets as Array<{ name: string; provider: string }>;
    expect(targets.some((t) => t.provider === "local")).toBe(true);
  });
});

describe("compute/kinds", () => {
  it("returns compute kind names", async () => {
    const res = ok(await router.dispatch(createRequest(1, "compute/kinds", {})));
    const kinds = res.kinds as string[];
    expect(Array.isArray(kinds)).toBe(true);
    expect(kinds.length).toBeGreaterThan(0);
    expect(kinds).toContain("local");
  });
});

describe("runtime/kinds", () => {
  it("returns runtime kind names", async () => {
    const res = ok(await router.dispatch(createRequest(1, "runtime/kinds", {})));
    const kinds = res.kinds as string[];
    expect(Array.isArray(kinds)).toBe(true);
    expect(kinds.length).toBeGreaterThan(0);
    expect(kinds).toContain("direct");
  });
});

describe("group/list", () => {
  it("returns session groups", async () => {
    const res = ok(await router.dispatch(createRequest(1, "group/list", {})));
    const groups = res.groups as unknown[];
    expect(Array.isArray(groups)).toBe(true);
  });

  it("includes a created group", async () => {
    await router.dispatch(createRequest(1, "group/create", { name: "test-list-group" }));
    const res = ok(await router.dispatch(createRequest(2, "group/list", {})));
    const groups = res.groups as Array<{ name: string }>;
    expect(groups.some((g) => g.name === "test-list-group")).toBe(true);
    await router.dispatch(createRequest(3, "group/delete", { name: "test-list-group" }));
  });
});
