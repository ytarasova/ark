/**
 * RPC boundary validation tests (P3-9).
 *
 * For each method covered by a Zod schema, assert:
 *   (a) a valid request passes through to the handler
 *   (b) an invalid request is rejected with code -32602 before the handler runs
 *   (c) a sample valid response parses against the response schema
 *
 * These tests focus on the validation middleware -- they do NOT exercise
 * real handlers (those are covered by per-handler integration tests). We
 * register stub handlers on a fresh Router so we can assert on the parsed
 * params the handler would see.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { Router } from "../router.js";
import { rpcMethodSchemas, COVERED_METHODS } from "../../protocol/rpc-schemas.js";
import { createRequest, ErrorCodes, type JsonRpcResponse, type JsonRpcError } from "../../protocol/types.js";

const sampleSession = {
  id: "s-abc123",
  ticket: null,
  summary: "test",
  repo: null,
  branch: null,
  compute_name: null,
  session_id: null,
  claude_session_id: null,
  stage: null,
  status: "ready",
  flow: "quick",
  agent: null,
  workdir: null,
  pr_url: null,
  pr_id: null,
  error: null,
  parent_id: null,
  fork_group: null,
  group_name: null,
  breakpoint_reason: null,
  attached_by: null,
  config: {},
  user_id: null,
  tenant_id: "default",
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

const sampleCompute = {
  name: "local",
  provider: "local",
  status: "running",
  config: {},
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

const sampleFlow = {
  name: "quick",
  description: "Quick flow",
  stages: [{ name: "code", gate: "auto" }],
};

const sampleAgent = {
  name: "claude",
  description: "Claude agent",
  model: "sonnet",
  max_turns: 200,
  system_prompt: "",
  tools: ["Bash"],
  mcp_servers: [],
  skills: [],
  memories: [],
  context: [],
  permission_mode: "bypassPermissions",
  env: {},
};

const sampleSkill = {
  name: "debug",
  description: "Debug helper",
  prompt: "",
};

const sampleSchedule = {
  id: "sch-1",
  cron: "0 * * * *",
  flow: "quick",
  enabled: true,
  created_at: new Date().toISOString(),
};

const sampleTodo = {
  id: 1,
  session_id: "s-abc123",
  content: "do it",
  done: false,
  created_at: new Date().toISOString(),
};

const sampleSessionOpResult = { ok: true, message: "done" };

interface MethodFixture {
  validRequest: Record<string, unknown>;
  invalidRequest: Record<string, unknown>;
  sampleResponse: unknown;
}

/**
 * One fixture per covered method. `validRequest` must parse; `invalidRequest`
 * must fail; `sampleResponse` must parse against the response schema.
 */
const fixtures: Record<string, MethodFixture> = {
  "session/start": {
    validRequest: { summary: "hello", repo: "/tmp/r", flow: "quick" },
    invalidRequest: { summary: 42 },
    sampleResponse: { session: sampleSession },
  },
  "session/read": {
    validRequest: { sessionId: "s-1", include: ["events"] },
    invalidRequest: { sessionId: "" },
    sampleResponse: { session: sampleSession, events: [] },
  },
  "session/list": {
    validRequest: { limit: 10 },
    invalidRequest: { limit: "ten" },
    sampleResponse: { sessions: [sampleSession] },
  },
  "session/delete": {
    validRequest: { sessionId: "s-1" },
    invalidRequest: { sessionId: 123 },
    sampleResponse: { ok: true },
  },
  "session/undelete": {
    validRequest: { sessionId: "s-1" },
    invalidRequest: {},
    sampleResponse: sampleSessionOpResult,
  },
  "session/fork": {
    validRequest: { sessionId: "s-1", name: "fork-name" },
    invalidRequest: { sessionId: 7 },
    sampleResponse: { session: sampleSession },
  },
  "session/stop": {
    validRequest: { sessionId: "s-1" },
    invalidRequest: {},
    sampleResponse: sampleSessionOpResult,
  },
  "session/advance": {
    validRequest: { sessionId: "s-1", force: true },
    invalidRequest: { sessionId: "s-1", force: "yes" },
    sampleResponse: sampleSessionOpResult,
  },
  "session/archive": {
    validRequest: { sessionId: "s-1" },
    invalidRequest: {},
    sampleResponse: sampleSessionOpResult,
  },
  "session/restore": {
    validRequest: { sessionId: "s-1" },
    invalidRequest: {},
    sampleResponse: sampleSessionOpResult,
  },
  "compute/list": {
    validRequest: {},
    // Root must be an object -- pass an array to trigger a failure.
    invalidRequest: [] as unknown as Record<string, unknown>,
    sampleResponse: { targets: [sampleCompute] },
  },
  "compute/create": {
    validRequest: { name: "devbox", provider: "ec2" },
    invalidRequest: { name: "devbox", provider: "mystery-cloud" },
    sampleResponse: { compute: sampleCompute },
  },
  "compute/read": {
    validRequest: { name: "devbox" },
    invalidRequest: {},
    sampleResponse: { compute: sampleCompute },
  },
  "flow/list": {
    validRequest: {},
    invalidRequest: [] as unknown as Record<string, unknown>,
    sampleResponse: { flows: [{ name: "quick", source: "builtin" }] },
  },
  "flow/read": {
    validRequest: { name: "quick" },
    invalidRequest: {},
    sampleResponse: { flow: sampleFlow },
  },
  "agent/list": {
    validRequest: {},
    invalidRequest: [] as unknown as Record<string, unknown>,
    sampleResponse: { agents: [sampleAgent] },
  },
  "skill/list": {
    validRequest: {},
    invalidRequest: [] as unknown as Record<string, unknown>,
    sampleResponse: { skills: [sampleSkill] },
  },
  "schedule/list": {
    validRequest: {},
    invalidRequest: [] as unknown as Record<string, unknown>,
    sampleResponse: { schedules: [sampleSchedule] },
  },
  "schedule/create": {
    validRequest: { cron: "0 * * * *", flow: "quick" },
    invalidRequest: {},
    sampleResponse: { schedule: sampleSchedule },
  },
  "costs/read": {
    validRequest: {},
    invalidRequest: [] as unknown as Record<string, unknown>,
    sampleResponse: { costs: [], total: 0 },
  },
  "dashboard/summary": {
    validRequest: {},
    invalidRequest: [] as unknown as Record<string, unknown>,
    sampleResponse: {
      counts: { total: 0 },
      costs: { total: 0, today: 0, week: 0, month: 0, byModel: {}, budget: null },
      recentEvents: [],
      topCostSessions: [],
      system: { conductor: true, router: false },
      activeCompute: 0,
    },
  },
  "todo/add": {
    validRequest: { sessionId: "s-1", content: "task" },
    invalidRequest: { sessionId: "s-1" },
    sampleResponse: { todo: sampleTodo },
  },
  "todo/toggle": {
    validRequest: { id: 1 },
    invalidRequest: { id: "one" },
    sampleResponse: { todo: sampleTodo },
  },
  "knowledge/stats": {
    validRequest: {},
    invalidRequest: [] as unknown as Record<string, unknown>,
    sampleResponse: { nodes: 0, edges: 0, by_node_type: {}, by_edge_type: {} },
  },
};

describe("RPC boundary validation", () => {
  it("covers every method registered in rpcMethodSchemas", () => {
    const uncovered = COVERED_METHODS.filter((m) => !(m in fixtures));
    expect(uncovered).toEqual([]);
  });

  describe("valid requests pass through to handler", () => {
    let router: Router;
    beforeEach(() => {
      router = new Router();
    });

    for (const method of COVERED_METHODS) {
      it(`${method}: valid request reaches handler`, async () => {
        let received: Record<string, unknown> | null = null;
        router.handle(method, async (params) => {
          received = params;
          return fixtures[method].sampleResponse;
        });
        const req = createRequest(1, method, fixtures[method].validRequest);
        const res = await router.dispatch(req);
        // Handler must have been invoked (no validation error)
        expect(received).not.toBeNull();
        // And the dispatch must have returned a success response
        expect("result" in (res as JsonRpcResponse)).toBe(true);
      });
    }
  });

  describe("invalid requests return -32602 before reaching handler", () => {
    let router: Router;
    beforeEach(() => {
      router = new Router();
    });

    for (const method of COVERED_METHODS) {
      it(`${method}: invalid request rejected with INVALID_PARAMS`, async () => {
        let handlerCalled = false;
        router.handle(method, async () => {
          handlerCalled = true;
          return fixtures[method].sampleResponse;
        });
        const req = createRequest(1, method, fixtures[method].invalidRequest);
        const res = await router.dispatch(req);
        expect(handlerCalled).toBe(false);
        expect((res as JsonRpcError).error.code).toBe(ErrorCodes.INVALID_PARAMS);
        // Message must name the method and must not contain a stack trace.
        expect((res as JsonRpcError).error.message).toContain(method);
        expect((res as JsonRpcError).error.message).not.toContain("at ");
      });
    }
  });

  describe("sample responses validate against schema", () => {
    for (const method of COVERED_METHODS) {
      it(`${method}: sample response parses against response schema`, () => {
        const result = rpcMethodSchemas[method].response.safeParse(fixtures[method].sampleResponse);
        if (!result.success) {
          // Include the zod error in the failure message for easier debugging.
          throw new Error(`${method} sample response failed: ${JSON.stringify(result.error.issues, null, 2)}`);
        }
        expect(result.success).toBe(true);
      });
    }
  });
});
