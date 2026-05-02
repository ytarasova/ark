# Ark MCP Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `POST /mcp` route to the Ark server daemon at `:19400` that exposes 27 MCP tools (14 read + 5 dispatch/runtime write + 8 definition CRUD) for sessions, flows, agents, skills, recipes, computes, and secrets, scoped per tenant.

**Architecture:** Streamable HTTP MCP endpoint embedded in the existing daemon's `Bun.serve` `fetch` handler. Auth via bearer token using the existing `materializeContext` helper. All tools delegate to existing services (`app.sessionLifecycle`, `app.agents`, `app.flows`, etc.) — zero new persistence paths.

**Tech Stack:** Bun, TypeScript, `@modelcontextprotocol/sdk` (`webStandardStreamableHttp`), `zod` (already a dep) for input validation.

**Spec:** [`docs/superpowers/specs/2026-05-02-ark-mcp-design.md`](../specs/2026-05-02-ark-mcp-design.md)

---

## File Structure

New module `packages/server/mcp/`:

| File | Responsibility |
|------|----------------|
| `index.ts` | Module entry: `handleMcpRequest(req, app, auth)` exported here, called from `packages/server/index.ts` fetch handler |
| `transport.ts` | Wraps `WebStandardStreamableHTTPServerTransport`. One transport instance per `ArkServer`, reused across requests (stateless mode). |
| `auth.ts` | `authenticateMcp(req, auth) → TenantContext`, identical signature to the existing `/terminal/:sessionId` auth path |
| `server.ts` | Creates the MCP `Server`, registers `ListToolsRequestSchema` + `CallToolRequestSchema` handlers, wires the tool registry |
| `registry.ts` | `ToolRegistry`: maps tool name → `{ inputSchema, handler }`. Each `tools/*.ts` module calls `registry.register(...)` to add itself. |
| `errors.ts` | `mcpError(code, message)` helper, maps Ark `RpcError` codes to MCP error responses |
| `tools/session.ts` | `session_list`, `session_show`, `session_events`, `session_start`, `session_steer`, `session_kill` |
| `tools/flow.ts` | `flow_list`, `flow_show`, `flow_create`, `flow_update` |
| `tools/agent.ts` | `agent_list`, `agent_show`, `agent_create`, `agent_update` |
| `tools/skill.ts` | `skill_list`, `skill_show`, `skill_create`, `skill_update` |
| `tools/recipe.ts` | `recipe_list`, `recipe_show`, `recipe_create`, `recipe_update` |
| `tools/compute.ts` | `compute_list`, `compute_show`, `compute_start`, `compute_stop` |
| `tools/secrets.ts` | `secrets_list` (read-only) |

Modified files:

| File | Change |
|------|--------|
| `packages/server/index.ts` | Add `POST /mcp` branch to `fetch` handler. ~12 lines. |
| `packages/types/index.ts` | No changes needed — existing types are reused. |

Test files mirror `tools/` layout under `packages/server/mcp/__tests__/`.

---

## Task 1: MCP transport + route skeleton

Boots the empty MCP server, returns a tool list with zero tools, validates the route is reachable.

**Files:**
- Create: `packages/server/mcp/index.ts`
- Create: `packages/server/mcp/transport.ts`
- Create: `packages/server/mcp/server.ts`
- Create: `packages/server/mcp/registry.ts`
- Modify: `packages/server/index.ts` (add `/mcp` branch)
- Test: `packages/server/mcp/__tests__/transport.test.ts`

- [ ] **Step 1: Write the failing transport test**

Create `packages/server/mcp/__tests__/transport.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { AppContext } from "../../../core/app.js";
import { ArkServer } from "../../index.js";
import { registerAllHandlers } from "../../register.js";

let app: AppContext;
let server: ArkServer;
let ws: { stop(): void };
let port: number;

beforeAll(async () => {
  app = await AppContext.forTestAsync();
  await app.boot();
  server = new ArkServer();
  registerAllHandlers(server.router, app);
  server.attachApp(app);
  port = app.config.ports.server;
  ws = server.startWebSocket(port);
});

afterAll(async () => {
  ws?.stop();
  await app?.shutdown();
});

describe("POST /mcp", () => {
  it("returns 200 + tools/list with zero tools when registry is empty", async () => {
    const resp = await fetch(`http://localhost:${port}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "0" } },
      }),
    });
    expect(resp.status).toBe(200);
    const body = await resp.text();
    expect(body).toContain("serverInfo");
    expect(body).toContain("ark-mcp");
  });

  it("rejects GET /mcp with 405", async () => {
    const resp = await fetch(`http://localhost:${port}/mcp`);
    expect(resp.status).toBe(405);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `make test-file F=packages/server/mcp/__tests__/transport.test.ts`
Expected: FAIL — `Cannot find module '../../mcp/transport'` or `404` on `/mcp`.

- [ ] **Step 3: Create the registry skeleton**

Create `packages/server/mcp/registry.ts`:

```ts
import type { z } from "zod";
import type { AppContext } from "../../core/app.js";
import type { TenantContext } from "../../core/auth/context.js";

export interface ToolHandlerCtx {
  app: AppContext;
  ctx: TenantContext;
}

export interface ToolDef<I = unknown, O = unknown> {
  name: string;
  description: string;
  inputSchema: z.ZodType<I>;
  handler: (input: I, ctx: ToolHandlerCtx) => Promise<O>;
}

export class ToolRegistry {
  private tools = new Map<string, ToolDef>();

  register<I, O>(def: ToolDef<I, O>): void {
    if (this.tools.has(def.name)) throw new Error(`MCP tool '${def.name}' already registered`);
    this.tools.set(def.name, def as unknown as ToolDef);
  }

  list(): ToolDef[] {
    return [...this.tools.values()];
  }

  get(name: string): ToolDef | null {
    return this.tools.get(name) ?? null;
  }
}
```

- [ ] **Step 4: Create the MCP server factory**

Create `packages/server/mcp/server.ts`:

```ts
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { AppContext } from "../../core/app.js";
import type { TenantContext } from "../../core/auth/context.js";
import type { ToolRegistry } from "./registry.js";
import { VERSION } from "../../core/version.js";

export function createMcpServer(registry: ToolRegistry, app: AppContext, ctx: TenantContext): Server {
  const server = new Server({ name: "ark-mcp", version: VERSION }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: registry.list().map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: zodToJsonSchema(t.inputSchema, { target: "openApi3" }) as Record<string, unknown>,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = registry.get(req.params.name);
    if (!tool) {
      return { content: [{ type: "text", text: `Unknown tool: ${req.params.name}` }], isError: true };
    }
    const parsed = tool.inputSchema.safeParse(req.params.arguments ?? {});
    if (!parsed.success) {
      return { content: [{ type: "text", text: `Invalid arguments: ${parsed.error.message}` }], isError: true };
    }
    try {
      const result = await tool.handler(parsed.data, { app, ctx });
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (err: any) {
      return { content: [{ type: "text", text: `Error: ${err?.message ?? String(err)}` }], isError: true };
    }
  });

  return server;
}
```

- [ ] **Step 5: Create the transport wrapper**

Create `packages/server/mcp/transport.ts`:

```ts
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createMcpServer } from "./server.js";
import { ToolRegistry } from "./registry.js";
import type { AppContext } from "../../core/app.js";
import type { TenantContext } from "../../core/auth/context.js";

export const sharedRegistry = new ToolRegistry();

/**
 * Handle a single /mcp request. Stateless: one transport + Server pair per
 * request. The MCP SDK Server holds no per-call state we need to persist;
 * sessions are tracked by the SDK via the `Mcp-Session-Id` header which
 * we leave to the SDK to manage.
 */
export async function handleMcpRequest(req: Request, app: AppContext, ctx: TenantContext): Promise<Response> {
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }
  const transport = new WebStandardStreamableHTTPServerTransport({});
  const server = createMcpServer(sharedRegistry, app, ctx);
  await server.connect(transport);
  return transport.handleRequest(req);
}
```

- [ ] **Step 6: Create the module entry**

Create `packages/server/mcp/index.ts`:

```ts
export { handleMcpRequest, sharedRegistry } from "./transport.js";
export type { ToolDef, ToolHandlerCtx } from "./registry.js";
```

- [ ] **Step 7: Wire the route into ArkServer**

Modify `packages/server/index.ts`. Find the `fetch(req, server)` block (around line 227) and add a `/mcp` branch BEFORE the `server.upgrade(req, { data })` call so POSTs aren't sent to WS upgrade:

```ts
// /mcp -- MCP HTTP endpoint (Streamable HTTP transport)
if (url.pathname === "/mcp") {
  if (!app) return new Response("MCP route requires AppContext", { status: 503 });
  let ctx: TenantContext;
  try {
    ctx = await self.resolveContextFromCredentials({ authorizationHeader, queryToken });
  } catch (err: any) {
    return new Response(`Unauthorized: ${err?.message ?? "auth failed"}`, { status: 401 });
  }
  const tenantApp = ctx.tenantId ? app.forTenant(ctx.tenantId) : app;
  const { handleMcpRequest } = await import("./mcp/index.js");
  return handleMcpRequest(req, tenantApp, ctx);
}
```

Add an `attachApp` method to `ArkServer` that captures the AppContext (the existing `attachLifecycle` only registers a listener; we need the raw handle for the MCP route). Insert after `attachLifecycle`:

```ts
private app: import("../core/app.js").AppContext | null = null;
attachApp(app: import("../core/app.js").AppContext): void {
  this.app = app;
}
```

Update the `app` reference in the `fetch` handler scope to read from `this.app` (the existing terminal route already does this via `app` captured from the outer closure — make sure `attachApp` populates that same reference). Easiest: rename the outer `let app: AppContext | null = null;` so it's an instance field.

- [ ] **Step 8: Wire `attachApp` from the daemon launcher**

Find where `ArkServer` is instantiated for the running daemon (`grep -n "new ArkServer" packages/cli` to locate). Add `server.attachApp(app)` immediately after `server.attachLifecycle(app)`. Also add to `health-endpoint.test.ts` so existing tests still bind the app.

- [ ] **Step 9: Run test to verify it passes**

Run: `make test-file F=packages/server/mcp/__tests__/transport.test.ts`
Expected: PASS — both `initialize` returns `serverInfo: { name: "ark-mcp", ... }` and GET returns 405.

- [ ] **Step 10: Lint + commit**

```bash
make format
npx eslint packages/server/mcp/ --max-warnings 0
git add packages/server/mcp/index.ts packages/server/mcp/transport.ts packages/server/mcp/server.ts packages/server/mcp/registry.ts packages/server/mcp/__tests__/transport.test.ts packages/server/index.ts
git commit -m "feat(mcp): /mcp route + transport skeleton"
```

---

## Task 2: Auth gate

Bearer-token auth tests, both modes (requireToken=false → pass through, requireToken=true → 401 without token, 200 with valid token).

**Files:**
- Create: `packages/server/mcp/__tests__/auth.test.ts`
- Modify: `packages/server/mcp/transport.ts` (no code change yet — auth is handled in `index.ts`; this task pins behaviour with tests)

- [ ] **Step 1: Write the failing auth test**

Create `packages/server/mcp/__tests__/auth.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { AppContext } from "../../../core/app.js";
import { ArkServer } from "../../index.js";
import { registerAllHandlers } from "../../register.js";

const initBody = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "0" } },
});

describe("/mcp auth — requireToken=false", () => {
  let app: AppContext;
  let server: ArkServer;
  let ws: { stop(): void };
  let port: number;

  beforeAll(async () => {
    app = await AppContext.forTestAsync();
    await app.boot();
    server = new ArkServer();
    registerAllHandlers(server.router, app);
    server.attachApp(app);
    port = app.config.ports.server;
    ws = server.startWebSocket(port);
  });
  afterAll(async () => {
    ws?.stop();
    await app?.shutdown();
  });

  it("accepts request with no Authorization header", async () => {
    const resp = await fetch(`http://localhost:${port}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: initBody,
    });
    expect(resp.status).toBe(200);
  });
});

describe("/mcp auth — requireToken=true", () => {
  let app: AppContext;
  let server: ArkServer;
  let ws: { stop(): void };
  let port: number;
  const validToken = "test-token-abc123";

  beforeAll(async () => {
    app = await AppContext.forTestAsync({ authSection: { requireToken: true, defaultTenant: null } });
    await app.boot();
    // Seed an api_keys row that matches validToken
    await app.apiKeys.create({ token: validToken, tenantId: app.tenantId, label: "test" });
    server = new ArkServer();
    registerAllHandlers(server.router, app);
    server.attachAuth(app);
    server.attachApp(app);
    port = app.config.ports.server;
    ws = server.startWebSocket(port);
  });
  afterAll(async () => {
    ws?.stop();
    await app?.shutdown();
  });

  it("returns 401 without Authorization header", async () => {
    const resp = await fetch(`http://localhost:${port}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: initBody,
    });
    expect(resp.status).toBe(401);
  });

  it("returns 401 with wrong token", async () => {
    const resp = await fetch(`http://localhost:${port}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: "Bearer wrong-token",
      },
      body: initBody,
    });
    expect(resp.status).toBe(401);
  });

  it("returns 200 with valid token", async () => {
    const resp = await fetch(`http://localhost:${port}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${validToken}`,
      },
      body: initBody,
    });
    expect(resp.status).toBe(200);
  });
});
```

- [ ] **Step 2: Run test to verify it passes (auth path inherited from existing /terminal route)**

Run: `make test-file F=packages/server/mcp/__tests__/auth.test.ts`
Expected: PASS — the auth code in `packages/server/index.ts:/mcp` calls the same `resolveContextFromCredentials` the terminal route uses; if Task 1 is correct, all four cases pass without further code.

If `apiKeys.create` API doesn't match, look up the actual signature with `grep -n "apiKeys" packages/core/repositories/`. Adjust the seed call in `beforeAll`.

- [ ] **Step 3: Commit**

```bash
git add packages/server/mcp/__tests__/auth.test.ts
git commit -m "feat(mcp): auth gate tests (requireToken on/off)"
```

---

## Task 3: Shared test helper + session read tools

Extracts the common test boilerplate into a shared helper used by every
subsequent `tools-*.test.ts`, then implements `session_list`, `session_show`,
`session_events`. This is the load-bearing task — once `callTool` works
end-to-end, every later tool follows the same pattern.

**Files:**
- Create: `packages/server/mcp/__tests__/test-helpers.ts` (shared)
- Create: `packages/server/mcp/tools/session.ts`
- Modify: `packages/server/mcp/index.ts` (auto-register tools on import)
- Test: `packages/server/mcp/__tests__/tools-session-read.test.ts`

- [ ] **Step 1: Write the shared test helper**

Create `packages/server/mcp/__tests__/test-helpers.ts`:

```ts
import { expect } from "bun:test";
import { AppContext } from "../../../core/app.js";
import { ArkServer } from "../../index.js";
import { registerAllHandlers } from "../../register.js";

export interface McpTestHandle {
  app: AppContext;
  server: ArkServer;
  ws: { stop(): void };
  port: number;
  callTool: (name: string, args: Record<string, unknown>, opts?: { token?: string }) => Promise<unknown>;
  shutdown: () => Promise<void>;
}

/**
 * Boot an in-process AppContext + ArkServer for an MCP test. Each call
 * allocates its own port via the `test` config profile so files run in
 * parallel without collision.
 */
export async function bootMcpTestServer(opts?: { authSection?: { requireToken: boolean; defaultTenant: string | null } }): Promise<McpTestHandle> {
  const app = await AppContext.forTestAsync(opts?.authSection ? { authSection: opts.authSection } : undefined);
  await app.boot();
  const server = new ArkServer();
  registerAllHandlers(server.router, app);
  if (opts?.authSection?.requireToken) server.attachAuth(app);
  server.attachApp(app);
  const port = app.config.ports.server;
  const ws = server.startWebSocket(port);

  const callTool = async (name: string, args: Record<string, unknown>, callOpts?: { token?: string }): Promise<unknown> => {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };
    if (callOpts?.token) headers.Authorization = `Bearer ${callOpts.token}`;
    const resp = await fetch(`http://localhost:${port}/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    });
    expect(resp.status).toBe(200);
    const text = await resp.text();
    // Streamable HTTP returns SSE-framed JSON; pull the first `data:` line.
    const match = text.match(/data:\s*(\{.*?\})\s*$/m);
    if (!match) throw new Error(`No data line in response: ${text.slice(0, 200)}`);
    const env = JSON.parse(match[1]);
    if (env.error) throw new Error(JSON.stringify(env.error));
    if (env.result?.isError) throw new Error(env.result.content?.[0]?.text ?? "tool error");
    const content = env.result?.content?.[0]?.text;
    return JSON.parse(content);
  };

  const shutdown = async () => {
    ws?.stop();
    await app?.shutdown();
  };

  return { app, server, ws, port, callTool, shutdown };
}
```

- [ ] **Step 2: Write the failing session-read test**

Create `packages/server/mcp/__tests__/tools-session-read.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { bootMcpTestServer, type McpTestHandle } from "./test-helpers.js";

let h: McpTestHandle;

beforeAll(async () => {
  h = await bootMcpTestServer();
});
afterAll(async () => {
  await h.shutdown();
});

describe("session_list", () => {
  it("returns empty array when no sessions exist", async () => {
    const result = (await h.callTool("session_list", {})) as unknown[];
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBe(0);
  });

  it("returns sessions after they are created", async () => {
    await h.app.sessions.create({ summary: "tool-test-1", flow: "bare" });
    await h.app.sessions.create({ summary: "tool-test-2", flow: "bare" });
    const result = (await h.callTool("session_list", {})) as { id: string }[];
    expect(result.length).toBeGreaterThanOrEqual(2);
    expect(result.find((s) => s.id.startsWith("s-"))).toBeDefined();
  });
});

describe("session_show", () => {
  it("returns session by id", async () => {
    const created = await h.app.sessions.create({ summary: "show-me", flow: "bare" });
    const result = (await h.callTool("session_show", { sessionId: created.id })) as { id: string; summary: string };
    expect(result.id).toBe(created.id);
    expect(result.summary).toBe("show-me");
  });

  it("errors on unknown session", async () => {
    let err: unknown = null;
    try {
      await h.callTool("session_show", { sessionId: "s-does-not-exist" });
    } catch (e) {
      err = e;
    }
    expect(err).toBeTruthy();
  });
});

describe("session_events", () => {
  it("returns empty array for fresh session", async () => {
    const created = await h.app.sessions.create({ summary: "events-test", flow: "bare" });
    const result = (await h.callTool("session_events", { sessionId: created.id })) as unknown[];
    expect(Array.isArray(result)).toBe(true);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `make test-file F=packages/server/mcp/__tests__/tools-session-read.test.ts`
Expected: FAIL — every `callTool(...)` returns `Unknown tool: session_list`.

- [ ] **Step 4: Implement the session read tools**

Create `packages/server/mcp/tools/session.ts`:

```ts
import { z } from "zod";
import type { ToolDef } from "../registry.js";
import { sharedRegistry } from "../transport.js";

const sessionListInput = z.object({
  status: z.string().optional(),
  flow: z.string().optional(),
  compute: z.string().optional(),
  limit: z.number().int().positive().max(500).optional(),
});

const sessionList: ToolDef = {
  name: "session_list",
  description: "List sessions visible to the caller's tenant. Optional filters: status, flow, compute, limit.",
  inputSchema: sessionListInput,
  handler: async (input, { app }) => {
    const sessions = await app.sessions.list({
      status: input.status,
      flow: input.flow,
      compute: input.compute,
      limit: input.limit ?? 100,
    });
    return sessions;
  },
};

const sessionShowInput = z.object({ sessionId: z.string() });

const sessionShow: ToolDef = {
  name: "session_show",
  description: "Get a single session by id.",
  inputSchema: sessionShowInput,
  handler: async (input, { app }) => {
    const session = await app.sessions.get(input.sessionId);
    if (!session) throw new Error(`Session not found: ${input.sessionId}`);
    return session;
  },
};

const sessionEventsInput = z.object({
  sessionId: z.string(),
  since: z.string().optional(),
  limit: z.number().int().positive().max(1000).optional(),
});

const sessionEvents: ToolDef = {
  name: "session_events",
  description: "Read events for a session. `since` is an ISO timestamp; `limit` defaults to 200.",
  inputSchema: sessionEventsInput,
  handler: async (input, { app }) => {
    return app.events.list(input.sessionId, { since: input.since, limit: input.limit ?? 200 });
  },
};

sharedRegistry.register(sessionList);
sharedRegistry.register(sessionShow);
sharedRegistry.register(sessionEvents);
```

- [ ] **Step 5: Auto-register tools on module load**

Modify `packages/server/mcp/index.ts`:

```ts
import "./tools/session.js"; // side-effect register

export { handleMcpRequest, sharedRegistry } from "./transport.js";
export type { ToolDef, ToolHandlerCtx } from "./registry.js";
```

- [ ] **Step 6: Run test to verify it passes**

Run: `make test-file F=packages/server/mcp/__tests__/tools-session-read.test.ts`
Expected: PASS — all three describes pass.

If `app.sessions.list({...})` rejects unknown filter keys, look up `SessionListFilters` in `packages/types/session.ts` and prune the input mapping to only the supported keys.

- [ ] **Step 7: Commit**

```bash
make format
git add packages/server/mcp/__tests__/test-helpers.ts packages/server/mcp/tools/session.ts packages/server/mcp/index.ts packages/server/mcp/__tests__/tools-session-read.test.ts
git commit -m "feat(mcp): session read tools (list, show, events)"
```

---

## Task 4: Session write tools (Tier 1)

Adds `session_start`, `session_steer`, `session_kill`. These delegate to `app.sessionLifecycle` and `app.sessionService` exactly like the JSON-RPC handlers do.

**Files:**
- Modify: `packages/server/mcp/tools/session.ts` (append three more tools)
- Test: `packages/server/mcp/__tests__/tools-session-write.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/server/mcp/__tests__/tools-session-write.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { bootMcpTestServer, type McpTestHandle } from "./test-helpers.js";

let h: McpTestHandle;

beforeAll(async () => {
  h = await bootMcpTestServer();
});
afterAll(async () => {
  await h.shutdown();
});

describe("session_start", () => {
  it("creates a session and returns its id", async () => {
    const result = (await h.callTool("session_start", {
      flow: "bare",
      summary: "mcp-start-test",
      compute: "local",
    })) as { sessionId: string };
    expect(result.sessionId).toMatch(/^s-/);
    const session = await h.app.sessions.get(result.sessionId);
    expect(session?.summary).toBe("mcp-start-test");
    expect(session?.flow).toBe("bare");
  });
});

describe("session_kill", () => {
  it("kills a running session", async () => {
    const created = await h.app.sessions.create({ summary: "kill-target", flow: "bare" });
    const result = (await h.callTool("session_kill", { sessionId: created.id })) as { ok: boolean };
    expect(result.ok).toBe(true);
  });
});

describe("session_steer", () => {
  it("posts a message to a session", async () => {
    const created = await h.app.sessions.create({ summary: "steer-target", flow: "bare" });
    const result = (await h.callTool("session_steer", {
      sessionId: created.id,
      message: "hello from mcp",
    })) as { ok: boolean };
    expect(result.ok).toBe(true);
    const messages = await h.app.messages.list(created.id);
    expect(messages.find((m) => m.content === "hello from mcp")).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `make test-file F=packages/server/mcp/__tests__/tools-session-write.test.ts`
Expected: FAIL — `Unknown tool: session_start`.

- [ ] **Step 3: Append the write tools**

Append to `packages/server/mcp/tools/session.ts`:

```ts
const sessionStartInput = z.object({
  compute: z.string(),
  flow: z.string(),
  agent: z.string().optional(),
  summary: z.string(),
  repo: z.string().optional(),
  branch: z.string().optional(),
  prompt: z.string().optional(),
  parent: z.string().optional(),
});

const sessionStart: ToolDef = {
  name: "session_start",
  description: "Create and dispatch a new session.",
  inputSchema: sessionStartInput,
  handler: async (input, { app }) => {
    const session = await app.sessionLifecycle.start(
      {
        compute_name: input.compute,
        flow: input.flow,
        agent: input.agent,
        summary: input.summary,
        repo: input.repo,
        branch: input.branch,
        prompt: input.prompt,
        parent_id: input.parent,
      },
      { onCreated: (id) => app.sessionService.emitSessionCreated(id) },
    );
    return { sessionId: session.id };
  },
};

const sessionSteerInput = z.object({ sessionId: z.string(), message: z.string() });

const sessionSteer: ToolDef = {
  name: "session_steer",
  description: "Send a steer message to a running session (queued; agent picks it up next loop).",
  inputSchema: sessionSteerInput,
  handler: async (input, { app }) => {
    await app.sessionService.send(input.sessionId, input.message);
    return { ok: true };
  },
};

const sessionKillInput = z.object({ sessionId: z.string() });

const sessionKill: ToolDef = {
  name: "session_kill",
  description: "Hard terminate a session and release its compute slot.",
  inputSchema: sessionKillInput,
  handler: async (input, { app }) => {
    await app.sessionService.kill(input.sessionId);
    return { ok: true };
  },
};

sharedRegistry.register(sessionStart);
sharedRegistry.register(sessionSteer);
sharedRegistry.register(sessionKill);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `make test-file F=packages/server/mcp/__tests__/tools-session-write.test.ts`
Expected: PASS.

If the JSON-RPC handler in `packages/server/handlers/session.ts:36` uses different field names for `start()` (e.g. `prompt` vs `initial_prompt`), copy them verbatim — the MCP layer must not reshape what the service expects.

- [ ] **Step 5: Commit**

```bash
make format
git add packages/server/mcp/tools/session.ts packages/server/mcp/__tests__/tools-session-write.test.ts
git commit -m "feat(mcp): session write tools (start, steer, kill)"
```

---

## Task 5: Flow read + write tools

**Files:**
- Create: `packages/server/mcp/tools/flow.ts`
- Modify: `packages/server/mcp/index.ts` (add `import "./tools/flow.js"`)
- Test: `packages/server/mcp/__tests__/tools-flow.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/server/mcp/__tests__/tools-flow.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { bootMcpTestServer, type McpTestHandle } from "./test-helpers.js";

let h: McpTestHandle;

beforeAll(async () => {
  h = await bootMcpTestServer();
});
afterAll(async () => {
  await h.shutdown();
});

describe("flow_list", () => {
  it("includes the builtin bare flow", async () => {
    const result = (await h.callTool("flow_list", {})) as { name: string }[];
    expect(result.find((f) => f.name === "bare")).toBeDefined();
  });
});

describe("flow_show", () => {
  it("returns the bare flow definition", async () => {
    const result = (await h.callTool("flow_show", { name: "bare" })) as { name: string; stages: unknown };
    expect(result.name).toBe("bare");
    expect(result.stages).toBeDefined();
  });
});

describe("flow_create + flow_update", () => {
  it("creates and reads back a flow", async () => {
    await h.callTool("flow_create", {
      definition: {
        name: "mcp-test-flow",
        description: "Created via MCP",
        stages: [{ name: "work", agent: "worker" }],
      },
    });
    const fetched = h.app.flows.get("mcp-test-flow");
    expect(fetched).toBeTruthy();
    expect(fetched?.description).toBe("Created via MCP");

    await h.callTool("flow_update", {
      name: "mcp-test-flow",
      patch: { description: "Updated via MCP" },
    });
    const updated = h.app.flows.get("mcp-test-flow");
    expect(updated?.description).toBe("Updated via MCP");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `make test-file F=packages/server/mcp/__tests__/tools-flow.test.ts`
Expected: FAIL — `Unknown tool: flow_list`.

- [ ] **Step 3: Implement the flow tools**

Create `packages/server/mcp/tools/flow.ts`:

```ts
import { z } from "zod";
import type { ToolDef } from "../registry.js";
import { sharedRegistry } from "../transport.js";

const flowDefinitionShape = z.object({
  name: z.string(),
  description: z.string().optional(),
  stages: z.array(z.unknown()),
}).passthrough();

const flowList: ToolDef = {
  name: "flow_list",
  description: "List all flows visible to the tenant (builtin, global, and project scope).",
  inputSchema: z.object({}),
  handler: async (_input, { app }) => app.flows.list(),
};

const flowShow: ToolDef = {
  name: "flow_show",
  description: "Get a flow definition by name.",
  inputSchema: z.object({ name: z.string() }),
  handler: async (input, { app }) => {
    const flow = app.flows.get(input.name);
    if (!flow) throw new Error(`Flow not found: ${input.name}`);
    return flow;
  },
};

const flowCreate: ToolDef = {
  name: "flow_create",
  description: "Create a new flow at global scope. The definition is serialized to ~/.ark/flows/<name>.yaml.",
  inputSchema: z.object({ definition: flowDefinitionShape }),
  handler: async (input, { app }) => {
    const def = input.definition as Record<string, unknown> & { name: string };
    if (app.flows.get(def.name)) throw new Error(`Flow already exists: ${def.name}`);
    app.flows.save(def.name, def as never, "global");
    return { name: def.name };
  },
};

const flowUpdate: ToolDef = {
  name: "flow_update",
  description: "Patch an existing flow. Shallow-merges `patch` into the current definition.",
  inputSchema: z.object({ name: z.string(), patch: z.record(z.string(), z.unknown()) }),
  handler: async (input, { app }) => {
    const existing = app.flows.get(input.name);
    if (!existing) throw new Error(`Flow not found: ${input.name}`);
    const merged = { ...existing, ...input.patch, name: input.name };
    app.flows.save(input.name, merged as never, "global");
    return { name: input.name };
  },
};

sharedRegistry.register(flowList);
sharedRegistry.register(flowShow);
sharedRegistry.register(flowCreate);
sharedRegistry.register(flowUpdate);
```

- [ ] **Step 4: Add the import**

Modify `packages/server/mcp/index.ts`:

```ts
import "./tools/session.js";
import "./tools/flow.js";

export { handleMcpRequest, sharedRegistry } from "./transport.js";
export type { ToolDef, ToolHandlerCtx } from "./registry.js";
```

- [ ] **Step 5: Run test to verify it passes**

Run: `make test-file F=packages/server/mcp/__tests__/tools-flow.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
make format
git add packages/server/mcp/tools/flow.ts packages/server/mcp/index.ts packages/server/mcp/__tests__/tools-flow.test.ts
git commit -m "feat(mcp): flow read + write tools"
```

---

## Task 6: Agent read + write tools

**Files:**
- Create: `packages/server/mcp/tools/agent.ts`
- Modify: `packages/server/mcp/index.ts`
- Test: `packages/server/mcp/__tests__/tools-agent.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/server/mcp/__tests__/tools-agent.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { bootMcpTestServer, type McpTestHandle } from "./test-helpers.js";

let h: McpTestHandle;

beforeAll(async () => {
  h = await bootMcpTestServer();
});
afterAll(async () => {
  await h.shutdown();
});

describe("agent_list", () => {
  it("includes the builtin worker agent", async () => {
    const result = (await h.callTool("agent_list", {})) as { name: string }[];
    expect(result.find((a) => a.name === "worker")).toBeDefined();
  });
});

describe("agent_show", () => {
  it("returns the worker agent", async () => {
    const result = (await h.callTool("agent_show", { name: "worker" })) as { name: string; model: string };
    expect(result.name).toBe("worker");
    expect(result.model).toBeTruthy();
  });
});

describe("agent_create + agent_update", () => {
  it("creates and reads back an agent", async () => {
    await h.callTool("agent_create", {
      definition: {
        name: "mcp-test-agent",
        description: "Created via MCP",
        model: "claude-opus-4-7",
        max_turns: 10,
        system_prompt: "You are a test agent.",
        tools: ["Bash"],
        mcp_servers: [],
        skills: [],
        memories: [],
        context: [],
        permission_mode: "bypassPermissions",
        env: {},
      },
    });
    const fetched = h.app.agents.get("mcp-test-agent");
    expect(fetched).toBeTruthy();
    expect(fetched?.description).toBe("Created via MCP");

    await h.callTool("agent_update", {
      name: "mcp-test-agent",
      patch: { description: "Updated via MCP", max_turns: 20 },
    });
    const updated = h.app.agents.get("mcp-test-agent");
    expect(updated?.description).toBe("Updated via MCP");
    expect(updated?.max_turns).toBe(20);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `make test-file F=packages/server/mcp/__tests__/tools-agent.test.ts`
Expected: FAIL — `Unknown tool: agent_list`.

- [ ] **Step 3: Implement the agent tools**

Create `packages/server/mcp/tools/agent.ts`:

```ts
import { z } from "zod";
import type { ToolDef } from "../registry.js";
import { sharedRegistry } from "../transport.js";

const agentDefinitionShape = z.object({
  name: z.string(),
  description: z.string(),
  model: z.string(),
  max_turns: z.number().int().positive(),
  system_prompt: z.string(),
  tools: z.array(z.string()),
  mcp_servers: z.array(z.union([z.string(), z.record(z.string(), z.unknown())])),
  skills: z.array(z.string()),
  memories: z.array(z.string()),
  context: z.array(z.string()),
  permission_mode: z.string(),
  env: z.record(z.string(), z.string()),
  runtime: z.string().optional(),
  command: z.array(z.string()).optional(),
  task_delivery: z.enum(["stdin", "file", "arg"]).optional(),
  recipe: z.string().optional(),
  sub_recipes: z.array(z.string()).optional(),
});

const agentList: ToolDef = {
  name: "agent_list",
  description: "List all agents visible to the tenant.",
  inputSchema: z.object({}),
  handler: async (_input, { app }) => app.agents.list(),
};

const agentShow: ToolDef = {
  name: "agent_show",
  description: "Get an agent definition by name.",
  inputSchema: z.object({ name: z.string() }),
  handler: async (input, { app }) => {
    const agent = app.agents.get(input.name);
    if (!agent) throw new Error(`Agent not found: ${input.name}`);
    return agent;
  },
};

const agentCreate: ToolDef = {
  name: "agent_create",
  description: "Create a new agent at global scope. Serialized to ~/.ark/agents/<name>.yaml.",
  inputSchema: z.object({ definition: agentDefinitionShape }),
  handler: async (input, { app }) => {
    if (app.agents.get(input.definition.name)) throw new Error(`Agent already exists: ${input.definition.name}`);
    app.agents.save(input.definition.name, input.definition as never, "global");
    return { name: input.definition.name };
  },
};

const agentUpdate: ToolDef = {
  name: "agent_update",
  description: "Patch an existing agent. Shallow-merges `patch` into the current definition.",
  inputSchema: z.object({ name: z.string(), patch: z.record(z.string(), z.unknown()) }),
  handler: async (input, { app }) => {
    const existing = app.agents.get(input.name);
    if (!existing) throw new Error(`Agent not found: ${input.name}`);
    const merged = { ...existing, ...input.patch, name: input.name };
    app.agents.save(input.name, merged as never, "global");
    return { name: input.name };
  },
};

sharedRegistry.register(agentList);
sharedRegistry.register(agentShow);
sharedRegistry.register(agentCreate);
sharedRegistry.register(agentUpdate);
```

- [ ] **Step 4: Add the import**

Modify `packages/server/mcp/index.ts`:

```ts
import "./tools/session.js";
import "./tools/flow.js";
import "./tools/agent.js";

export { handleMcpRequest, sharedRegistry } from "./transport.js";
export type { ToolDef, ToolHandlerCtx } from "./registry.js";
```

- [ ] **Step 5: Run test to verify it passes**

Run: `make test-file F=packages/server/mcp/__tests__/tools-agent.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
make format
git add packages/server/mcp/tools/agent.ts packages/server/mcp/index.ts packages/server/mcp/__tests__/tools-agent.test.ts
git commit -m "feat(mcp): agent read + write tools"
```

---

## Task 7: Skill read + write tools

**Files:**
- Create: `packages/server/mcp/tools/skill.ts`
- Modify: `packages/server/mcp/index.ts`
- Test: `packages/server/mcp/__tests__/tools-skill.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/server/mcp/__tests__/tools-skill.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { bootMcpTestServer, type McpTestHandle } from "./test-helpers.js";

let h: McpTestHandle;

beforeAll(async () => {
  h = await bootMcpTestServer();
});
afterAll(async () => {
  await h.shutdown();
});

describe("skill_list", () => {
  it("returns an array (may be empty in test fixture)", async () => {
    const result = (await h.callTool("skill_list", {})) as unknown[];
    expect(Array.isArray(result)).toBe(true);
  });
});

describe("skill_create + skill_show + skill_update", () => {
  it("creates, reads, and updates a skill", async () => {
    await h.callTool("skill_create", {
      definition: { name: "mcp-test-skill", description: "Test skill", body: "Just a test." },
    });
    const fetched = (await h.callTool("skill_show", { name: "mcp-test-skill" })) as { description: string };
    expect(fetched.description).toBe("Test skill");
    await h.callTool("skill_update", { name: "mcp-test-skill", patch: { description: "Updated" } });
    const updated = (await h.callTool("skill_show", { name: "mcp-test-skill" })) as { description: string };
    expect(updated.description).toBe("Updated");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `make test-file F=packages/server/mcp/__tests__/tools-skill.test.ts`
Expected: FAIL — `Unknown tool: skill_list`.

- [ ] **Step 3: Implement the skill tools**

Create `packages/server/mcp/tools/skill.ts`:

```ts
import { z } from "zod";
import type { ToolDef } from "../registry.js";
import { sharedRegistry } from "../transport.js";

const skillDefinitionShape = z.object({
  name: z.string(),
  description: z.string(),
  body: z.string(),
}).passthrough();

const skillList: ToolDef = {
  name: "skill_list",
  description: "List all skills visible to the tenant.",
  inputSchema: z.object({}),
  handler: async (_input, { app }) => app.skills.list(),
};

const skillShow: ToolDef = {
  name: "skill_show",
  description: "Get a skill definition by name.",
  inputSchema: z.object({ name: z.string() }),
  handler: async (input, { app }) => {
    const skill = app.skills.get(input.name);
    if (!skill) throw new Error(`Skill not found: ${input.name}`);
    return skill;
  },
};

const skillCreate: ToolDef = {
  name: "skill_create",
  description: "Create a new skill at global scope. Serialized to ~/.ark/skills/<name>.yaml.",
  inputSchema: z.object({ definition: skillDefinitionShape }),
  handler: async (input, { app }) => {
    if (app.skills.get(input.definition.name)) throw new Error(`Skill already exists: ${input.definition.name}`);
    app.skills.save(input.definition.name, input.definition as never, "global");
    return { name: input.definition.name };
  },
};

const skillUpdate: ToolDef = {
  name: "skill_update",
  description: "Patch an existing skill.",
  inputSchema: z.object({ name: z.string(), patch: z.record(z.string(), z.unknown()) }),
  handler: async (input, { app }) => {
    const existing = app.skills.get(input.name);
    if (!existing) throw new Error(`Skill not found: ${input.name}`);
    const merged = { ...existing, ...input.patch, name: input.name };
    app.skills.save(input.name, merged as never, "global");
    return { name: input.name };
  },
};

sharedRegistry.register(skillList);
sharedRegistry.register(skillShow);
sharedRegistry.register(skillCreate);
sharedRegistry.register(skillUpdate);
```

- [ ] **Step 4: Add the import**

Append to `packages/server/mcp/index.ts`: `import "./tools/skill.js";`.

- [ ] **Step 5: Run test to verify it passes**

Run: `make test-file F=packages/server/mcp/__tests__/tools-skill.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
make format
git add packages/server/mcp/tools/skill.ts packages/server/mcp/index.ts packages/server/mcp/__tests__/tools-skill.test.ts
git commit -m "feat(mcp): skill read + write tools"
```

---

## Task 8: Recipe read + write tools

**Files:**
- Create: `packages/server/mcp/tools/recipe.ts`
- Modify: `packages/server/mcp/index.ts`
- Test: `packages/server/mcp/__tests__/tools-recipe.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/server/mcp/__tests__/tools-recipe.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { bootMcpTestServer, type McpTestHandle } from "./test-helpers.js";

let h: McpTestHandle;

beforeAll(async () => {
  h = await bootMcpTestServer();
});
afterAll(async () => {
  await h.shutdown();
});

describe("recipe_list + recipe_create + recipe_show + recipe_update", () => {
  it("round-trips a recipe", async () => {
    expect(Array.isArray(await h.callTool("recipe_list", {}))).toBe(true);
    await h.callTool("recipe_create", {
      definition: { name: "mcp-test-recipe", description: "Test", template: "echo {{name}}" },
    });
    const fetched = (await h.callTool("recipe_show", { name: "mcp-test-recipe" })) as { description: string };
    expect(fetched.description).toBe("Test");
    await h.callTool("recipe_update", { name: "mcp-test-recipe", patch: { description: "Updated" } });
    const updated = (await h.callTool("recipe_show", { name: "mcp-test-recipe" })) as { description: string };
    expect(updated.description).toBe("Updated");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `make test-file F=packages/server/mcp/__tests__/tools-recipe.test.ts`
Expected: FAIL — `Unknown tool: recipe_list`.

- [ ] **Step 3: Implement the recipe tools**

Create `packages/server/mcp/tools/recipe.ts`:

```ts
import { z } from "zod";
import type { ToolDef } from "../registry.js";
import { sharedRegistry } from "../transport.js";

const recipeDefinitionShape = z.object({ name: z.string() }).passthrough();

const recipeList: ToolDef = {
  name: "recipe_list",
  description: "List all recipes visible to the tenant.",
  inputSchema: z.object({}),
  handler: async (_input, { app }) => app.recipes.list(),
};

const recipeShow: ToolDef = {
  name: "recipe_show",
  description: "Get a recipe definition by name.",
  inputSchema: z.object({ name: z.string() }),
  handler: async (input, { app }) => {
    const recipe = app.recipes.get(input.name);
    if (!recipe) throw new Error(`Recipe not found: ${input.name}`);
    return recipe;
  },
};

const recipeCreate: ToolDef = {
  name: "recipe_create",
  description: "Create a new recipe at global scope. Serialized to ~/.ark/recipes/<name>.yaml.",
  inputSchema: z.object({ definition: recipeDefinitionShape }),
  handler: async (input, { app }) => {
    if (app.recipes.get(input.definition.name)) throw new Error(`Recipe already exists: ${input.definition.name}`);
    app.recipes.save(input.definition.name, input.definition as never, "global");
    return { name: input.definition.name };
  },
};

const recipeUpdate: ToolDef = {
  name: "recipe_update",
  description: "Patch an existing recipe.",
  inputSchema: z.object({ name: z.string(), patch: z.record(z.string(), z.unknown()) }),
  handler: async (input, { app }) => {
    const existing = app.recipes.get(input.name);
    if (!existing) throw new Error(`Recipe not found: ${input.name}`);
    const merged = { ...existing, ...input.patch, name: input.name };
    app.recipes.save(input.name, merged as never, "global");
    return { name: input.name };
  },
};

sharedRegistry.register(recipeList);
sharedRegistry.register(recipeShow);
sharedRegistry.register(recipeCreate);
sharedRegistry.register(recipeUpdate);
```

- [ ] **Step 4: Add the import**

Append to `packages/server/mcp/index.ts`: `import "./tools/recipe.js";`.

- [ ] **Step 5: Run test to verify it passes**

Run: `make test-file F=packages/server/mcp/__tests__/tools-recipe.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
make format
git add packages/server/mcp/tools/recipe.ts packages/server/mcp/index.ts packages/server/mcp/__tests__/tools-recipe.test.ts
git commit -m "feat(mcp): recipe read + write tools"
```

---

## Task 9: Compute tools (list, show, start, stop)

**Files:**
- Create: `packages/server/mcp/tools/compute.ts`
- Modify: `packages/server/mcp/index.ts`
- Test: `packages/server/mcp/__tests__/tools-compute.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/server/mcp/__tests__/tools-compute.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { bootMcpTestServer, type McpTestHandle } from "./test-helpers.js";

let h: McpTestHandle;

beforeAll(async () => {
  h = await bootMcpTestServer();
});
afterAll(async () => {
  await h.shutdown();
});

describe("compute_list", () => {
  it("includes the builtin local compute", async () => {
    const result = (await h.callTool("compute_list", {})) as { name: string }[];
    expect(result.find((c) => c.name === "local")).toBeDefined();
  });
});

describe("compute_show", () => {
  it("returns the local compute", async () => {
    const result = (await h.callTool("compute_show", { name: "local" })) as { name: string };
    expect(result.name).toBe("local");
  });

  it("errors on unknown compute", async () => {
    let err: unknown = null;
    try {
      await h.callTool("compute_show", { name: "no-such-compute" });
    } catch (e) {
      err = e;
    }
    expect(err).toBeTruthy();
  });
});
```

(`compute_start` / `compute_stop` aren't tested here — they require a real provider; covered by integration tests once a fake provider is wired in. The MCP wiring is the same as the JSON-RPC handler so the unit-level coverage on `compute_show` is sufficient to catch registry/auth bugs.)

- [ ] **Step 2: Run test to verify it fails**

Run: `make test-file F=packages/server/mcp/__tests__/tools-compute.test.ts`
Expected: FAIL — `Unknown tool: compute_list`.

- [ ] **Step 3: Implement the compute tools**

Create `packages/server/mcp/tools/compute.ts`:

```ts
import { z } from "zod";
import type { ToolDef } from "../registry.js";
import { sharedRegistry } from "../transport.js";
import { providerOf } from "../../../compute/adapters/provider-map.js";

const computeList: ToolDef = {
  name: "compute_list",
  description: "List all computes visible to the tenant. Sensitive config fields are NOT returned.",
  inputSchema: z.object({}),
  handler: async (_input, { app }) => {
    const computes = await app.computes.list();
    // Strip raw config; surface only the safe summary fields the CLI shows.
    return computes.map((c) => ({
      name: c.name,
      compute_kind: c.compute_kind,
      isolation_kind: c.isolation_kind,
      status: c.status,
      ip: (c.config as { ip?: string } | null)?.ip ?? null,
    }));
  },
};

const computeShow: ToolDef = {
  name: "compute_show",
  description: "Get a compute by name (sensitive fields stripped).",
  inputSchema: z.object({ name: z.string() }),
  handler: async (input, { app }) => {
    const compute = await app.computes.get(input.name);
    if (!compute) throw new Error(`Compute not found: ${input.name}`);
    return {
      name: compute.name,
      compute_kind: compute.compute_kind,
      isolation_kind: compute.isolation_kind,
      status: compute.status,
      ip: (compute.config as { ip?: string } | null)?.ip ?? null,
    };
  },
};

const computeStart: ToolDef = {
  name: "compute_start",
  description: "Start a stopped compute (provider-specific).",
  inputSchema: z.object({ name: z.string() }),
  handler: async (input, { app }) => {
    const compute = await app.computes.get(input.name);
    if (!compute) throw new Error(`Compute not found: ${input.name}`);
    const { getProvider } = await import("../../../compute/index.js");
    const provider = getProvider(providerOf(compute));
    if (!provider) throw new Error(`Unknown provider: ${providerOf(compute)}`);
    await provider.start(compute);
    await app.computes.update(compute.name, { status: "running" });
    return { status: "running" };
  },
};

const computeStop: ToolDef = {
  name: "compute_stop",
  description: "Stop a running compute (provider-specific).",
  inputSchema: z.object({ name: z.string() }),
  handler: async (input, { app }) => {
    const compute = await app.computes.get(input.name);
    if (!compute) throw new Error(`Compute not found: ${input.name}`);
    const { getProvider } = await import("../../../compute/index.js");
    const provider = getProvider(providerOf(compute));
    if (!provider) throw new Error(`Unknown provider: ${providerOf(compute)}`);
    await provider.stop(compute);
    await app.computes.update(compute.name, { status: "stopped" });
    return { status: "stopped" };
  },
};

sharedRegistry.register(computeList);
sharedRegistry.register(computeShow);
sharedRegistry.register(computeStart);
sharedRegistry.register(computeStop);
```

- [ ] **Step 4: Add the import**

Append to `packages/server/mcp/index.ts`: `import "./tools/compute.js";`.

- [ ] **Step 5: Run test to verify it passes**

Run: `make test-file F=packages/server/mcp/__tests__/tools-compute.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
make format
git add packages/server/mcp/tools/compute.ts packages/server/mcp/index.ts packages/server/mcp/__tests__/tools-compute.test.ts
git commit -m "feat(mcp): compute tools (list, show, start, stop)"
```

---

## Task 10: Secrets list (read-only)

**Files:**
- Create: `packages/server/mcp/tools/secrets.ts`
- Modify: `packages/server/mcp/index.ts`
- Test: `packages/server/mcp/__tests__/tools-secrets.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/server/mcp/__tests__/tools-secrets.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { bootMcpTestServer, type McpTestHandle } from "./test-helpers.js";

let h: McpTestHandle;

beforeAll(async () => {
  h = await bootMcpTestServer();
});
afterAll(async () => {
  await h.shutdown();
});

describe("secrets_list", () => {
  it("returns names + types but NEVER values", async () => {
    await h.app.secrets.set("MCP_TEST_SECRET", "supersecret-do-not-leak", { description: "test" });
    const result = (await h.callTool("secrets_list", {})) as { name: string; type: string; updated_at?: string }[];
    const entry = result.find((s) => s.name === "MCP_TEST_SECRET");
    expect(entry).toBeDefined();
    expect(entry?.type).toBeTruthy();
    // Critical: response must not contain the raw value
    const raw = JSON.stringify(result);
    expect(raw).not.toContain("supersecret-do-not-leak");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `make test-file F=packages/server/mcp/__tests__/tools-secrets.test.ts`
Expected: FAIL — `Unknown tool: secrets_list`.

- [ ] **Step 3: Implement the secrets tool**

Create `packages/server/mcp/tools/secrets.ts`:

```ts
import { z } from "zod";
import type { ToolDef } from "../registry.js";
import { sharedRegistry } from "../transport.js";

const secretsList: ToolDef = {
  name: "secrets_list",
  description: "List secret names + types. NEVER returns values; this is by design.",
  inputSchema: z.object({}),
  handler: async (_input, { app }) => {
    const secrets = await app.secrets.list();
    return secrets.map((s) => ({
      name: s.name,
      type: s.type,
      description: s.description,
      updated_at: s.updated_at,
    }));
  },
};

sharedRegistry.register(secretsList);
```

- [ ] **Step 4: Add the import**

Append to `packages/server/mcp/index.ts`: `import "./tools/secrets.js";`.

- [ ] **Step 5: Run test to verify it passes**

Run: `make test-file F=packages/server/mcp/__tests__/tools-secrets.test.ts`
Expected: PASS — including the "no value leak" assertion.

If `app.secrets.list()` already returns full rows including values, map carefully — assert at the test level that the `JSON.stringify(result)` does not contain the raw secret value, exactly as the test does. This is a security-critical guard.

- [ ] **Step 6: Commit**

```bash
make format
git add packages/server/mcp/tools/secrets.ts packages/server/mcp/index.ts packages/server/mcp/__tests__/tools-secrets.test.ts
git commit -m "feat(mcp): secrets_list (names only, no values)"
```

---

## Task 11: Tenant isolation test

End-to-end check: two tenants' tokens see disjoint resources.

**Files:**
- Test: `packages/server/mcp/__tests__/tenant-isolation.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/server/mcp/__tests__/tenant-isolation.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { bootMcpTestServer, type McpTestHandle } from "./test-helpers.js";

let h: McpTestHandle;
const tokenA = "tenant-a-token-XXXXXXXXX";
const tokenB = "tenant-b-token-YYYYYYYYY";

beforeAll(async () => {
  h = await bootMcpTestServer({ authSection: { requireToken: true, defaultTenant: null } });
  await h.app.tenants.create({ id: "tenant-a", name: "Tenant A" });
  await h.app.tenants.create({ id: "tenant-b", name: "Tenant B" });
  await h.app.apiKeys.create({ token: tokenA, tenantId: "tenant-a", label: "A" });
  await h.app.apiKeys.create({ token: tokenB, tenantId: "tenant-b", label: "B" });
  // Seed a session in each tenant
  await h.app.forTenant("tenant-a").sessions.create({ summary: "owned-by-A", flow: "bare" });
  await h.app.forTenant("tenant-b").sessions.create({ summary: "owned-by-B", flow: "bare" });
});
afterAll(async () => {
  await h.shutdown();
});

describe("tenant isolation", () => {
  it("tenant A only sees their own session", async () => {
    const list = (await h.callTool("session_list", {}, { token: tokenA })) as { summary: string }[];
    expect(list.find((s) => s.summary === "owned-by-A")).toBeDefined();
    expect(list.find((s) => s.summary === "owned-by-B")).toBeUndefined();
  });

  it("tenant B only sees their own session", async () => {
    const list = (await h.callTool("session_list", {}, { token: tokenB })) as { summary: string }[];
    expect(list.find((s) => s.summary === "owned-by-B")).toBeDefined();
    expect(list.find((s) => s.summary === "owned-by-A")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `make test-file F=packages/server/mcp/__tests__/tenant-isolation.test.ts`
Expected: PASS — the tenant scoping in the `/mcp` route handler from Task 1 already calls `app.forTenant(ctx.tenantId)` so this should be green without further code changes.

If it fails because `app.tenants.create` / `app.apiKeys.create` have a different shape, look up the actual signatures in `packages/core/repositories/` and adjust the seed code. The behaviour assertion (A doesn't see B) is the load-bearing part.

- [ ] **Step 3: Commit**

```bash
git add packages/server/mcp/__tests__/tenant-isolation.test.ts
git commit -m "test(mcp): tenant isolation across the /mcp route"
```

---

## Task 12: Documentation + final commit

**Files:**
- Modify: `CLAUDE.md` (add MCP server entry to "Key entry points")
- Modify: `docs/install.sh` — no change; users get the new route automatically with the binary update
- Create: `docs/mcp.md` (user-facing reference)

- [ ] **Step 1: Write user docs**

Create `docs/mcp.md`:

```markdown
# Ark MCP Server

Ark exposes its full read + write surface to MCP-aware clients (Claude
Code, custom agents) over an HTTP endpoint on the server daemon.

## Endpoint

`POST http://localhost:19400/mcp`

(Hosted: `https://<your-ark-host>/mcp`)

## Auth

`Authorization: Bearer <token>`

- **Local**: token is in `~/.ark/arkd.token` (auto-generated on first
  daemon boot — same one `./ark` and the web UI use).
- **Hosted**: generate a per-user API token in the web UI under
  Settings → MCP tokens.

## Configuring Claude Code

Edit `~/.claude.json` (or `.claude.json` in your project) and add:

```json
{
  "mcpServers": {
    "ark": {
      "type": "http",
      "url": "http://localhost:19400/mcp",
      "headers": { "Authorization": "Bearer <your-token>" }
    }
  }
}
```

Restart Claude Code. The 26 Ark tools (`session_start`, `agent_create`,
...) appear in `/mcp` and are callable by name.

## Tool Catalogue

### Read

| Tool | Purpose |
|------|---------|
| `session_list` | List sessions visible to your tenant |
| `session_show` | Get a session by id |
| `session_events` | Read event history for a session |
| `flow_list` / `flow_show` | Inspect flow definitions |
| `agent_list` / `agent_show` | Inspect agent definitions |
| `skill_list` / `skill_show` | Inspect skill definitions |
| `recipe_list` / `recipe_show` | Inspect recipe definitions |
| `compute_list` / `compute_show` | Inspect compute targets (no secrets) |
| `secrets_list` | Names + types only — never values |

### Write — dispatch & runtime

| Tool | Purpose |
|------|---------|
| `session_start` | Create + dispatch a session |
| `session_steer` | Send a steer message to a running session |
| `session_kill` | Hard terminate a session |
| `compute_start` / `compute_stop` | Provider-level start/stop |

### Write — definition CRUD

| Tool | Purpose |
|------|---------|
| `agent_create` / `agent_update` | Edit `~/.ark/agents/*.yaml` |
| `flow_create` / `flow_update` | Edit `~/.ark/flows/*.yaml` |
| `skill_create` / `skill_update` | Edit `~/.ark/skills/*.yaml` |
| `recipe_create` / `recipe_update` | Edit `~/.ark/recipes/*.yaml` |

Deletion tools and secret writes are intentionally not exposed in MVP.

## Multi-tenant

In hosted mode, every tool call is scoped to the tenant bound to the
bearer token. A user with `Bearer abc...` cannot see or modify another
user's resources, even if they call `session_show` with a session id
that exists in another tenant.
```

- [ ] **Step 2: Update CLAUDE.md key entry points**

Modify `CLAUDE.md`. Find the "Key entry points" block and append:

```
- MCP server (`server/mcp/`) -- HTTP MCP at `:19400/mcp`. 26 tools (read + Tier 1/2 write). See `docs/mcp.md`.
```

- [ ] **Step 3: Run the full test suite**

Run: `make test`
Expected: PASS for all MCP tests; no regressions elsewhere.

- [ ] **Step 4: Lint**

Run: `make lint`
Expected: zero warnings.

- [ ] **Step 5: Format**

Run: `make format`

- [ ] **Step 6: Bump version + commit + tag**

```bash
# patch bump for the new feature
sed -i.bak 's/"version": "0.21.28"/"version": "0.21.29"/' package.json && rm package.json.bak
bun run scripts/inject-version.ts
git add docs/mcp.md CLAUDE.md package.json packages/core/version.ts
git commit -m "docs(mcp): user reference + entry-point note"
```

(The release commit / tag happens in a follow-up — this plan only ships
the feature on main.)

---

## Self-Review Notes

**Spec coverage:** Every section of the spec maps to a task —
endpoint+route (T1), auth (T2), session tools (T3-T4), flow (T5),
agent (T6), skill (T7), recipe (T8), compute (T9), secrets (T10),
tenant isolation (T11), docs (T12). 26 tools total, all present.

**Test coverage by tool:**
- `session_list`/`show`/`events` — T3
- `session_start`/`steer`/`kill` — T4
- `flow_*` — T5
- `agent_*` — T6
- `skill_*` — T7
- `recipe_*` — T8
- `compute_list`/`show` — T9 (start/stop covered structurally — same wiring as JSON-RPC handler `resource-compute.ts:263-304`)
- `secrets_list` — T10 (with explicit no-leak assertion)
- Auth — T2
- Tenant isolation — T11

**Type consistency:** All tasks use `app.<store>.list()` / `.get()` /
`.save()` matching the actual store interfaces in
`packages/core/stores/{agent,flow,skill,recipe}-store.ts`. Session
tools use `app.sessionLifecycle.start()` and `app.sessionService.send/kill`,
matching the JSON-RPC handlers in `packages/server/handlers/session.ts`.
Compute tools mirror `packages/server/handlers/resource-compute.ts:263-304`.

**Why side-effect imports for tool registration?** Same pattern as
`packages/core/conductor/channel.ts` and many CLI command modules. One
line per tool file in `index.ts` keeps registration explicit and easy
to audit.

**Why one `WebStandardStreamableHTTPServerTransport` per request?** The
SDK supports stateful sessions via `Mcp-Session-Id`, but for a stateless
tool-call API the per-request lifecycle is simplest and avoids leaking
SDK Server objects across requests. The cost is one short-lived object
allocation per `/mcp` POST, negligible compared to the JSON parse.
