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
  "input/upload": {
    validRequest: { name: "goose.yaml", role: "recipe", content: "aGVsbG8=", contentEncoding: "base64" },
    invalidRequest: { name: "x.yaml", role: "r" },
    sampleResponse: { locator: "X2xvY2FsL2lucHV0cy9hYmMtcmVjaXBlL2dvb3NlLnlhbWw" },
  },
  "input/read": {
    validRequest: { locator: "X2xvY2FsL2lucHV0cy9hYmMtcmVjaXBlL2dvb3NlLnlhbWw" },
    invalidRequest: { locator: 42 },
    sampleResponse: {
      filename: "goose.yaml",
      contentType: "application/x-yaml",
      content: "aGVsbG8=",
      contentEncoding: "base64",
      size: 5,
    },
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
  "todo/list": {
    validRequest: { sessionId: "s-1" },
    invalidRequest: {},
    sampleResponse: { todos: [sampleTodo] },
  },
  "todo/delete": {
    validRequest: { id: 1 },
    invalidRequest: { id: "one" },
    sampleResponse: { ok: true },
  },
  "verify/run": {
    validRequest: { sessionId: "s-1" },
    invalidRequest: {},
    sampleResponse: { ok: true, todosResolved: true, pendingTodos: [], scriptResults: [] },
  },
  "session/output": {
    validRequest: { sessionId: "s-1", lines: 100 },
    invalidRequest: { sessionId: "" },
    sampleResponse: { output: "" },
  },
  "session/recording": {
    validRequest: { sessionId: "s-1" },
    invalidRequest: {},
    sampleResponse: { ok: true, output: null },
  },
  "session/events": {
    validRequest: { sessionId: "s-1", limit: 10 },
    invalidRequest: { sessionId: 1 },
    sampleResponse: { events: [] },
  },
  "session/messages": {
    validRequest: { sessionId: "s-1", limit: 10 },
    invalidRequest: { sessionId: 1 },
    sampleResponse: { messages: [] },
  },
  "session/export-data": {
    validRequest: { sessionId: "s-1" },
    invalidRequest: {},
    sampleResponse: { version: 1, exportedAt: new Date().toISOString(), session: {}, events: [] },
  },
  "session/import": {
    validRequest: { version: 1, session: { summary: "test" } },
    invalidRequest: {},
    sampleResponse: { ok: true, sessionId: "s-1" },
  },
  "session/resume": {
    validRequest: { sessionId: "s-1" },
    invalidRequest: {},
    sampleResponse: { ok: true },
  },
  "session/clone": {
    validRequest: { sessionId: "s-1" },
    invalidRequest: {},
    sampleResponse: { session: sampleSession },
  },
  "session/pause": {
    validRequest: { sessionId: "s-1" },
    invalidRequest: {},
    sampleResponse: { ok: true },
  },
  "session/interrupt": {
    validRequest: { sessionId: "s-1", content: "stop that" },
    invalidRequest: {},
    sampleResponse: sampleSessionOpResult,
  },
  "session/inject": {
    validRequest: { sessionId: "s-1", content: "heads up" },
    invalidRequest: { sessionId: "s-1" },
    sampleResponse: { ok: true },
  },
  "session/complete": {
    validRequest: { sessionId: "s-1" },
    invalidRequest: {},
    sampleResponse: sampleSessionOpResult,
  },
  "session/spawn": {
    validRequest: { sessionId: "s-1", task: "do it" },
    invalidRequest: { sessionId: "s-1" },
    sampleResponse: { ok: true },
  },
  "session/unread-counts": {
    validRequest: {},
    invalidRequest: [] as unknown as Record<string, unknown>,
    sampleResponse: { counts: {} },
  },
  "session/conversation": {
    validRequest: { sessionId: "s-1" },
    invalidRequest: {},
    sampleResponse: { turns: [] },
  },
  "message/send": {
    validRequest: { sessionId: "s-1", content: "hi" },
    invalidRequest: { sessionId: "s-1" },
    sampleResponse: sampleSessionOpResult,
  },
  "message/markRead": {
    validRequest: { sessionId: "s-1" },
    invalidRequest: {},
    sampleResponse: { ok: true },
  },
  "gate/approve": {
    validRequest: { sessionId: "s-1" },
    invalidRequest: {},
    sampleResponse: { ok: true },
  },
  "gate/reject": {
    validRequest: { sessionId: "s-1", reason: "nope" },
    invalidRequest: { sessionId: "s-1" },
    sampleResponse: { ok: true },
  },
  "costs/session": {
    validRequest: { sessionId: "s-1" },
    invalidRequest: {},
    sampleResponse: {
      cost: 0,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      total_tokens: 0,
    },
  },
  "cost/export": {
    validRequest: {},
    invalidRequest: [] as unknown as Record<string, unknown>,
    sampleResponse: { csv: "" },
  },
  "search/sessions": {
    validRequest: { query: "foo" },
    invalidRequest: {},
    sampleResponse: { sessions: [], transcripts: [] },
  },
  "search/global": {
    validRequest: { query: "foo" },
    invalidRequest: {},
    sampleResponse: [],
  },
  "history/list": {
    validRequest: { limit: 10 },
    invalidRequest: [] as unknown as Record<string, unknown>,
    sampleResponse: { items: [] },
  },
  "history/refresh-and-index": {
    validRequest: {},
    invalidRequest: [] as unknown as Record<string, unknown>,
    sampleResponse: { ok: true, sessionCount: 0, indexCount: 0, items: [] },
  },
  "history/rebuild-fts": {
    validRequest: {},
    invalidRequest: [] as unknown as Record<string, unknown>,
    sampleResponse: { ok: true },
  },
  "status/get": {
    validRequest: {},
    invalidRequest: [] as unknown as Record<string, unknown>,
    sampleResponse: { total: 0, byStatus: {} },
  },
  "daemon/status": {
    validRequest: {},
    invalidRequest: [] as unknown as Record<string, unknown>,
    sampleResponse: {
      conductor: { online: true, url: "http://localhost" },
      arkd: { online: false, url: "http://localhost" },
      router: { online: false },
    },
  },
  "group/list": {
    validRequest: {},
    invalidRequest: [] as unknown as Record<string, unknown>,
    sampleResponse: { groups: [] },
  },
  "config/get": {
    validRequest: {},
    invalidRequest: [] as unknown as Record<string, unknown>,
    sampleResponse: { hotkeys: {}, theme: {}, profile: {}, mode: "local", hosted: false },
  },
  "profile/list": {
    validRequest: {},
    invalidRequest: [] as unknown as Record<string, unknown>,
    sampleResponse: { profiles: [] },
  },
  "profile/create": {
    validRequest: { name: "p1" },
    invalidRequest: {},
    sampleResponse: { profile: { name: "p1" } },
  },
  "profile/delete": {
    validRequest: { name: "p1" },
    invalidRequest: {},
    sampleResponse: { ok: true },
  },
  "tools/list": {
    validRequest: {},
    invalidRequest: [] as unknown as Record<string, unknown>,
    sampleResponse: { tools: [] },
  },
  "mcp/attach-by-dir": {
    validRequest: { dir: "/tmp", name: "srv", config: {} },
    invalidRequest: { dir: "/tmp", name: "srv" },
    sampleResponse: { ok: true },
  },
  "mcp/detach-by-dir": {
    validRequest: { dir: "/tmp", name: "srv" },
    invalidRequest: { dir: "/tmp" },
    sampleResponse: { ok: true },
  },
  "skill/save": {
    validRequest: { name: "s1" },
    invalidRequest: {},
    sampleResponse: { ok: true, name: "s1" },
  },
  "skill/delete": {
    validRequest: { name: "s1" },
    invalidRequest: {},
    sampleResponse: { ok: true },
  },
  "recipe/list": {
    validRequest: {},
    invalidRequest: [] as unknown as Record<string, unknown>,
    sampleResponse: { recipes: [] },
  },
  "recipe/delete": {
    validRequest: { name: "r1" },
    invalidRequest: {},
    sampleResponse: { ok: true },
  },
  "runtime/list": {
    validRequest: {},
    invalidRequest: [] as unknown as Record<string, unknown>,
    sampleResponse: { runtimes: [] },
  },
  "runtime/read": {
    validRequest: { name: "claude" },
    invalidRequest: {},
    sampleResponse: { runtime: { name: "claude", type: "cli" } },
  },
  "agent/create": {
    validRequest: { name: "a1" },
    invalidRequest: {},
    sampleResponse: { ok: true, name: "a1" },
  },
  "agent/update": {
    validRequest: { name: "a1" },
    invalidRequest: {},
    sampleResponse: { ok: true, name: "a1" },
  },
  "agent/delete": {
    validRequest: { name: "a1" },
    invalidRequest: {},
    sampleResponse: { ok: true },
  },
  "flow/create": {
    validRequest: { name: "f1", stages: [{ name: "code" }] },
    invalidRequest: { name: "f1" },
    sampleResponse: { ok: true, name: "f1" },
  },
  "flow/delete": {
    validRequest: { name: "f1" },
    invalidRequest: {},
    sampleResponse: { ok: true },
  },
  "worktree/list": {
    validRequest: {},
    invalidRequest: [] as unknown as Record<string, unknown>,
    sampleResponse: { worktrees: [] },
  },
  "worktree/diff": {
    validRequest: { sessionId: "s-1" },
    invalidRequest: {},
    sampleResponse: {},
  },
  "worktree/finish": {
    validRequest: { sessionId: "s-1" },
    invalidRequest: {},
    sampleResponse: sampleSessionOpResult,
  },
  "worktree/create-pr": {
    validRequest: { sessionId: "s-1" },
    invalidRequest: {},
    sampleResponse: { ok: true },
  },
  "worktree/cleanup": {
    validRequest: {},
    invalidRequest: [] as unknown as Record<string, unknown>,
    sampleResponse: { ok: true },
  },
  "learning/list": {
    validRequest: {},
    invalidRequest: [] as unknown as Record<string, unknown>,
    sampleResponse: { learnings: [] },
  },
  "learning/add": {
    validRequest: { title: "t", description: "d" },
    invalidRequest: {},
    sampleResponse: {
      ok: true,
      learning: { title: "t", description: "d", recurrence: 1, lastSeen: new Date().toISOString() },
      promoted: false,
    },
  },
  "memory/list": {
    validRequest: {},
    invalidRequest: [] as unknown as Record<string, unknown>,
    sampleResponse: { memories: [] },
  },
  "memory/recall": {
    validRequest: { query: "foo" },
    invalidRequest: {},
    sampleResponse: { results: [] },
  },
  "memory/add": {
    validRequest: { content: "c" },
    invalidRequest: {},
    sampleResponse: {
      memory: {
        id: "m1",
        content: "c",
        tags: [],
        scope: "global",
        importance: 1,
        createdAt: new Date().toISOString(),
        accessedAt: new Date().toISOString(),
        accessCount: 0,
      },
    },
  },
  "memory/forget": {
    validRequest: { id: "m1" },
    invalidRequest: {},
    sampleResponse: { ok: true },
  },
  "knowledge/ingest": {
    validRequest: { path: "/tmp/x" },
    invalidRequest: {},
    sampleResponse: { ok: true },
  },
  "knowledge/search": {
    validRequest: { query: "foo" },
    invalidRequest: {},
    sampleResponse: { results: [] },
  },
  "knowledge/index": {
    validRequest: {},
    invalidRequest: [] as unknown as Record<string, unknown>,
    sampleResponse: { ok: true },
  },
  "knowledge/export": {
    validRequest: {},
    invalidRequest: [] as unknown as Record<string, unknown>,
    sampleResponse: { ok: true },
  },
  "knowledge/import": {
    validRequest: {},
    invalidRequest: [] as unknown as Record<string, unknown>,
    sampleResponse: { ok: true },
  },
  "schedule/delete": {
    validRequest: { id: "sch-1" },
    invalidRequest: {},
    sampleResponse: { ok: true },
  },
  "schedule/enable": {
    validRequest: { id: "sch-1" },
    invalidRequest: {},
    sampleResponse: { ok: true },
  },
  "schedule/disable": {
    validRequest: { id: "sch-1" },
    invalidRequest: {},
    sampleResponse: { ok: true },
  },
  "compute/provision": {
    validRequest: { name: "devbox" },
    invalidRequest: {},
    sampleResponse: { ok: true },
  },
  "compute/start-instance": {
    validRequest: { name: "devbox" },
    invalidRequest: {},
    sampleResponse: { ok: true },
  },
  "compute/stop-instance": {
    validRequest: { name: "devbox" },
    invalidRequest: {},
    sampleResponse: { ok: true },
  },
  "compute/destroy": {
    validRequest: { name: "devbox" },
    invalidRequest: {},
    sampleResponse: { ok: true },
  },
  "metrics/snapshot": {
    validRequest: {},
    invalidRequest: [] as unknown as Record<string, unknown>,
    sampleResponse: { snapshot: null },
  },
  "compute/kill-process": {
    validRequest: { pid: 123 },
    invalidRequest: {},
    sampleResponse: { ok: true },
  },
  "compute/docker-logs": {
    validRequest: { container: "c1" },
    invalidRequest: {},
    sampleResponse: { logs: "" },
  },
  "compute/docker-action": {
    validRequest: { container: "c1", action: "stop" },
    invalidRequest: { container: "c1", action: "blow-up" },
    sampleResponse: { ok: true },
  },
  "compute/template/list": {
    validRequest: {},
    invalidRequest: [] as unknown as Record<string, unknown>,
    sampleResponse: { templates: [] },
  },
  "repo-map/get": {
    validRequest: {},
    invalidRequest: [] as unknown as Record<string, unknown>,
    sampleResponse: {},
  },
  "fs/list-dir": {
    validRequest: {},
    invalidRequest: [] as unknown as Record<string, unknown>,
    sampleResponse: { cwd: "/tmp", parent: null, home: "/home/u", entries: [] },
  },
};

describe("RPC boundary validation", async () => {
  it("covers every method registered in rpcMethodSchemas", () => {
    const uncovered = COVERED_METHODS.filter((m) => !(m in fixtures));
    expect(uncovered).toEqual([]);
  });

  describe("valid requests pass through to handler", async () => {
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

  describe("invalid requests return -32602 before reaching handler", async () => {
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
