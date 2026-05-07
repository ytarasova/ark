# Conductor + Server Daemon Merge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse the conductor (`:19100` REST + SSE) and server daemon (`:19400` JSON-RPC + WS) into a single HTTP service hosted by `packages/conductor/` (renamed from `packages/server/`), retiring REST and SSE for everything Ark controls. End state: one port (`19400`), one process role, one internal protocol stack (JSON-RPC over WebSocket), with external REST surfaces (OpenAI proxy, GitHub webhooks, MCP, terminal WS, health) re-mounted unchanged.

**Architecture:** Big-bang cutover. Phase A renames config / env / constants. Phase B adds the new JSON-RPC handlers that replace conductor's REST surface (additive, the old surface still serves). Phase C extends `ArkClient` with worker-facing methods. Phase D switches callers (arkd, web UI) to the new endpoints. Phase E rips out `packages/core/conductor/`, the `ConductorLauncher`, and the JSON-RPC bridge file. Phase F renames the package directory. Phase G is verification.

**Tech Stack:** Bun + TypeScript, ES modules with `.js` extensions, JSON-RPC over WebSocket via the existing `Router` machinery in `packages/server/router.ts`, `bun:test`, drizzle (no schema changes), tenant scoping via `app.apiKeys`.

**Spec:** `docs/superpowers/specs/2026-05-06-conductor-server-merge-design.md`

---

## Pre-flight

### Task 0: Verify branch + baseline

**Files:** none

- [ ] **Step 1: Confirm clean working tree**

Run: `git status`
Expected: clean tree.

- [ ] **Step 2: Create feature branch**

Run: `git checkout -b conductor-server-merge`

- [ ] **Step 3: Run the baseline test suite**

Run: `make test`
Expected: all tests pass on `main`. If any fail before we start, stop and fix or surface to the human.

- [ ] **Step 4: Run lint**

Run: `make lint`
Expected: zero warnings. If not, stop.

---

## Phase A: Config / env / constant rename

The old conductor port (`19100`) and its config slot delete; the old server slot (`19400`) renames into the `conductor` slot. Net: a single `config.ports.conductor` field holding `19400`, a single `ARK_CONDUCTOR_PORT` env var, a single `DEFAULT_CONDUCTOR_PORT` constant. Prep for everything else.

### Task A1: Update `packages/core/constants.ts`

**Files:**
- Modify: `packages/core/constants.ts`

- [ ] **Step 1: Locate the existing port constants**

Run: `grep -n "DEFAULT_CONDUCTOR_PORT\|DEFAULT_SERVER_PORT" packages/core/constants.ts`
Expected: two distinct constants, one for `19100` and one for `19400`.

- [ ] **Step 2: Edit constants**

In `packages/core/constants.ts`:
- Delete the existing `DEFAULT_CONDUCTOR_PORT` line (the one set to `19100`).
- Rename `DEFAULT_SERVER_PORT` to `DEFAULT_CONDUCTOR_PORT`. Its value (`19400`) is unchanged.

- [ ] **Step 3: Update all imports across the repo**

Run: `grep -rn "DEFAULT_SERVER_PORT" packages/ --include="*.ts"`
Edit every match: `DEFAULT_SERVER_PORT` -> `DEFAULT_CONDUCTOR_PORT`.

- [ ] **Step 4: Confirm no stale `DEFAULT_SERVER_PORT` references**

Run: `grep -rn "DEFAULT_SERVER_PORT" packages/ --include="*.ts"`
Expected: no output.

- [ ] **Step 5: Type-check the workspace**

Run: `bun x tsc --noEmit`
Expected: no errors. Stop and fix any that appear.

- [ ] **Step 6: Commit**

```bash
git add packages/core/constants.ts packages/
git commit -m "rename(config): merge DEFAULT_SERVER_PORT into DEFAULT_CONDUCTOR_PORT"
```

### Task A2: Update `packages/core/config/types.ts` and `config.ts`

**Files:**
- Modify: `packages/core/config/types.ts`
- Modify: `packages/core/config.ts`

- [ ] **Step 1: Locate the ports type**

Run: `grep -n "ports:" packages/core/config/types.ts`
Expected: a `PortsConfig` (or similarly named) interface with at least `conductor` and `server` fields.

- [ ] **Step 2: Edit `PortsConfig`**

In `packages/core/config/types.ts`:
- Delete the existing `conductor` field (held the old `19100`).
- Rename the `server` field to `conductor`. Type stays `number`.

- [ ] **Step 3: Update `config.ts` defaults loader**

In `packages/core/config.ts`, find every reference to `ports.server` and `ports.conductor`, and apply the same rename: delete reads of the old `ports.conductor`, then rename `ports.server` reads to `ports.conductor`. Use `DEFAULT_CONDUCTOR_PORT` (now =19400) as the default.

- [ ] **Step 4: Type-check**

Run: `bun x tsc --noEmit`
Expected: no errors. (TypeScript will surface every dangling `ports.server` reference to fix.)

- [ ] **Step 5: Update every dangling reader**

For each TS error from step 4, edit the reference: `config.ports.server` -> `config.ports.conductor`. Re-run `bun x tsc --noEmit` until clean.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "rename(config): collapse ports.server into ports.conductor"
```

### Task A3: Update `packages/core/config/profiles.ts` defaults

**Files:**
- Modify: `packages/core/config/profiles.ts`

- [ ] **Step 1: Locate profile port defaults**

Run: `grep -n "server\|conductor" packages/core/config/profiles.ts`
Expected: each profile (`local`, `control-plane`, `test`) has its port allocations.

- [ ] **Step 2: Apply the rename to every profile**

For `local`, `control-plane`, and `test` profiles:
- Delete the old `conductor: 19100` entries (or the equivalent test allocation).
- Rename `server: <port>` to `conductor: <port>`.

- [ ] **Step 3: Type-check + commit**

```bash
bun x tsc --noEmit
git add packages/core/config/profiles.ts
git commit -m "rename(config): drop conductor=19100 slot from profiles"
```

### Task A4: Update env source

**Files:**
- Modify: `packages/core/config/env-source.ts`

- [ ] **Step 1: Locate env mappings**

Run: `grep -n "ARK_CONDUCTOR_PORT\|ARK_SERVER_PORT" packages/core/config/env-source.ts`
Expected: two mappings.

- [ ] **Step 2: Edit env-source**

- Delete the `ARK_CONDUCTOR_PORT` mapping (was -> old `ports.conductor`).
- Rename the `ARK_SERVER_PORT` mapping to `ARK_CONDUCTOR_PORT` (now -> the new `ports.conductor` field).

- [ ] **Step 3: Grep for callers**

Run: `grep -rn "ARK_SERVER_PORT" packages/ --include="*.ts"`
Edit every match: `ARK_SERVER_PORT` -> `ARK_CONDUCTOR_PORT`.

- [ ] **Step 4: Confirm none remain**

Run: `grep -rn "ARK_SERVER_PORT" packages/`
Expected: no output.

- [ ] **Step 5: Type-check + commit**

```bash
bun x tsc --noEmit
git add -A
git commit -m "rename(env): merge ARK_SERVER_PORT into ARK_CONDUCTOR_PORT"
```

### Task A5: Update CLAUDE.md env-var table

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Locate the env table**

Run: `grep -n "ARK_CONDUCTOR_PORT\|ARK_SERVER_PORT" CLAUDE.md`
Expected: rows in the env-var -> Config field map table.

- [ ] **Step 2: Edit the table**

In `CLAUDE.md`:
- Delete the row for `ARK_SERVER_PORT`.
- Update the `ARK_CONDUCTOR_PORT` row's default to `19400` and clarify it now points at the merged service.

- [ ] **Step 3: Update the port-map paragraph**

Find: `Port map: 19100 (conductor), 19300 (arkd), 19400 (server daemon WS), 8420 (web).`
Replace with: `Port map: 19400 (conductor), 19300 (arkd), 8420 (web).`

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(claude-md): retire 19100 + ARK_SERVER_PORT from env table"
```

### Task A6: Run baseline test pass after Phase A

- [ ] **Step 1: Run tests**

Run: `make test`
Expected: all tests pass. The renames are mechanical; if anything fails, the test was reading `ports.server` somewhere not yet caught - fix and amend the relevant Phase A commit (or add a new commit if the offender spans multiple tasks).

- [ ] **Step 2: Lint**

Run: `make lint`
Expected: zero warnings.

---

## Phase B: New JSON-RPC handlers (additive)

Add the JSON-RPC methods that will replace conductor's REST surface. The old REST endpoints continue to serve in this phase - the new handlers run in parallel. This keeps every commit shippable. Old handlers come down in Phase E.

The handler patterns follow `packages/server/handlers/session.ts`:
- `router.handle("method/name", async (params, notify, ctx) => { ... })`
- `const opts = extract<T>(params, ["requiredKey1", "requiredKey2"]);`
- `const scoped = resolveTenantApp(app, ctx);`
- `throw new RpcError("msg", ErrorCodes.X);` for errors
- `notify("event/name", payload)` for server-push

Tests boot via `AppContext.forTestAsync()` + `app.boot()`, dispatch through a fresh `Router`, and assert results.

### Task B1: `worker/register` handler + test

**Files:**
- Create: `packages/server/handlers/worker.ts`
- Create: `packages/server/__tests__/worker-register.test.ts`
- Modify: `packages/server/register.ts` (or wherever handlers are wired up - check first)

- [ ] **Step 1: Find where session handlers get registered**

Run: `grep -n "registerSessionHandlers" packages/server/register.ts packages/server/index.ts 2>/dev/null`
Expected: identify the central registration point.

- [ ] **Step 2: Write the failing test**

In `packages/server/__tests__/worker-register.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { AppContext } from "../../core/app.js";
import { registerWorkerHandlers } from "../handlers/worker.js";
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
  registerWorkerHandlers(router, app);
});

describe("worker/register", () => {
  it("registers a worker and returns the assigned id", async () => {
    const req = createRequest("worker/register", {
      computeId: "test-compute-1",
      capabilities: { runtimes: ["claude-agent"] },
    });
    const res = (await router.dispatch(req, () => {}, {})) as JsonRpcResponse;
    expect(res.result).toBeDefined();
    const result = res.result as { workerId: string };
    expect(result.workerId).toBe("test-compute-1");
  });
});
```

- [ ] **Step 3: Run the test (should fail)**

Run: `make test-file F=packages/server/__tests__/worker-register.test.ts`
Expected: FAIL with "Cannot find module ../handlers/worker.js" or similar.

- [ ] **Step 4: Implement the handler**

Create `packages/server/handlers/worker.ts`:

```ts
import { Router } from "../router.js";
import type { AppContext } from "../../core/app.js";
import { extract } from "../validate.js";
import { resolveTenantApp } from "./scope-helpers.js";

export function registerWorkerHandlers(router: Router, app: AppContext): void {
  router.handle("worker/register", async (params, _notify, ctx) => {
    const opts = extract<{
      computeId: string;
      capabilities?: Record<string, unknown>;
    }>(params, ["computeId"]);
    const scoped = resolveTenantApp(app, ctx);
    // Reuse existing worker-registry logic that was previously called from
    // the REST handler in packages/core/conductor/server/. The registry
    // surface lives on AppContext (or its repository) - port the existing
    // call site verbatim from the REST handler.
    const workerId = await scoped.workers.register({
      computeId: opts.computeId,
      capabilities: opts.capabilities ?? {},
    });
    return { workerId };
  });
}
```

Note: `scoped.workers` is the worker registry that the conductor REST handler currently uses. Find the existing call site in `packages/core/conductor/server/` and use the same accessor + method. If the registry is exposed differently on AppContext, adjust the call to match. The handler body should mirror what the REST endpoint does today, just with the JSON-RPC envelope around it.

- [ ] **Step 5: Wire the handler into the central registration**

In `packages/server/register.ts` (or the equivalent entry point identified in step 1):

```ts
import { registerWorkerHandlers } from "./handlers/worker.js";
// ... existing imports
export function registerAllHandlers(router: Router, app: AppContext): void {
  // ... existing calls
  registerWorkerHandlers(router, app);
}
```

- [ ] **Step 6: Run the test (should pass)**

Run: `make test-file F=packages/server/__tests__/worker-register.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/server/handlers/worker.ts packages/server/__tests__/worker-register.test.ts packages/server/register.ts
git commit -m "feat(server): add worker/register JSON-RPC handler"
```

### Task B2: `worker/heartbeat` handler + test

**Files:**
- Modify: `packages/server/handlers/worker.ts`
- Modify: `packages/server/__tests__/worker-register.test.ts` (add new describe block, OR create `worker-heartbeat.test.ts`)

- [ ] **Step 1: Write the failing test**

Add to the test file (same module or new file):

```ts
describe("worker/heartbeat", () => {
  it("accepts a heartbeat for a registered worker", async () => {
    // Register first
    const reg = createRequest("worker/register", { computeId: "hb-compute-1" });
    await router.dispatch(reg, () => {}, {});
    // Then heartbeat
    const hb = createRequest("worker/heartbeat", { computeId: "hb-compute-1" });
    const res = (await router.dispatch(hb, () => {}, {})) as JsonRpcResponse;
    expect(res.result).toBeDefined();
  });

  it("returns -32003 for a heartbeat from an unknown worker", async () => {
    const hb = createRequest("worker/heartbeat", { computeId: "never-registered" });
    const res = (await router.dispatch(hb, () => {}, {})) as JsonRpcResponse;
    expect(res.error?.code).toBe(-32003);
  });
});
```

- [ ] **Step 2: Run the test (fails)**

Run: `make test-file F=packages/server/__tests__/worker-register.test.ts`
Expected: FAIL ("worker/heartbeat" not registered).

- [ ] **Step 3: Implement the handler**

In `packages/server/handlers/worker.ts`, inside `registerWorkerHandlers`:

```ts
router.handle("worker/heartbeat", async (params, _notify, ctx) => {
  const opts = extract<{ computeId: string }>(params, ["computeId"]);
  const scoped = resolveTenantApp(app, ctx);
  const ok = await scoped.workers.heartbeat(opts.computeId);
  if (!ok) {
    throw new RpcError("worker not registered", -32003);
  }
  return { ok: true };
});
```

(`RpcError` and the error-code constant: check `packages/protocol/types.ts` for the canonical pattern and reuse. If `-32003` isn't defined yet in `ErrorCodes`, add it as `WORKER_NOT_REGISTERED = -32003` in the same file.)

- [ ] **Step 4: Run tests (pass)**

Run: `make test-file F=packages/server/__tests__/worker-register.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(server): add worker/heartbeat JSON-RPC handler"
```

### Task B3: `worker/deregister` + `worker/list` handlers + tests

**Files:**
- Modify: `packages/server/handlers/worker.ts`
- Modify: `packages/server/__tests__/worker-register.test.ts`

- [ ] **Step 1: Write failing tests**

Add to test file:

```ts
describe("worker/deregister", () => {
  it("removes a registered worker", async () => {
    await router.dispatch(createRequest("worker/register", { computeId: "dr-1" }), () => {}, {});
    const res = (await router.dispatch(
      createRequest("worker/deregister", { computeId: "dr-1" }),
      () => {},
      {},
    )) as JsonRpcResponse;
    expect(res.result).toBeDefined();
    // Subsequent heartbeat should now fail
    const hb = (await router.dispatch(
      createRequest("worker/heartbeat", { computeId: "dr-1" }),
      () => {},
      {},
    )) as JsonRpcResponse;
    expect(hb.error?.code).toBe(-32003);
  });
});

describe("worker/list", () => {
  it("returns currently registered workers", async () => {
    await router.dispatch(createRequest("worker/register", { computeId: "list-1" }), () => {}, {});
    await router.dispatch(createRequest("worker/register", { computeId: "list-2" }), () => {}, {});
    const res = (await router.dispatch(createRequest("worker/list", {}), () => {}, {})) as JsonRpcResponse;
    const result = res.result as { workers: Array<{ computeId: string }> };
    const ids = result.workers.map((w) => w.computeId);
    expect(ids).toContain("list-1");
    expect(ids).toContain("list-2");
  });
});
```

- [ ] **Step 2: Run tests (fail)**

Run: `make test-file F=packages/server/__tests__/worker-register.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement handlers**

Add to `packages/server/handlers/worker.ts`:

```ts
router.handle("worker/deregister", async (params, _notify, ctx) => {
  const opts = extract<{ computeId: string }>(params, ["computeId"]);
  const scoped = resolveTenantApp(app, ctx);
  await scoped.workers.deregister(opts.computeId);
  return { ok: true };
});

router.handle("worker/list", async (_params, _notify, ctx) => {
  const scoped = resolveTenantApp(app, ctx);
  const workers = await scoped.workers.list();
  return { workers };
});
```

- [ ] **Step 4: Run tests (pass)**

Run: `make test-file F=packages/server/__tests__/worker-register.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(server): add worker/deregister + worker/list JSON-RPC handlers"
```

### Task B4: `channel/deliver` handler + test

**Files:**
- Create: `packages/server/handlers/channel.ts`
- Create: `packages/server/__tests__/channel-deliver.test.ts`
- Modify: `packages/server/register.ts`

- [ ] **Step 1: Locate the existing REST channel deliver implementation**

Run: `grep -rn "channel/deliver\|channelDeliver\|/api/channel/" packages/core/conductor/`
Expected: find the REST handler at `packages/core/conductor/server/...` that handles `POST /api/channel/:sessionId`.

- [ ] **Step 2: Write the failing test**

Create `packages/server/__tests__/channel-deliver.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { AppContext } from "../../core/app.js";
import { registerChannelHandlers } from "../handlers/channel.js";
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
  registerChannelHandlers(router, app);
});

describe("channel/deliver", () => {
  it("delivers a payload to the target session's channel bus", async () => {
    const session = await app.sessions.create({ summary: "channel-target" });
    const received: unknown[] = [];
    // Subscribe via existing channel-bus machinery (look up the
    // accessor used by the REST handler today).
    const unsubscribe = app.channelBus.subscribe(session.id, (msg: unknown) => {
      received.push(msg);
    });
    try {
      const req = createRequest("channel/deliver", {
        targetSession: session.id,
        payload: { kind: "test", value: 42 },
      });
      const res = (await router.dispatch(req, () => {}, {})) as JsonRpcResponse;
      expect(res.result).toBeDefined();
      expect(received).toHaveLength(1);
      expect((received[0] as { value: number }).value).toBe(42);
    } finally {
      unsubscribe();
    }
  });

  it("returns -32004 for an unknown session", async () => {
    const req = createRequest("channel/deliver", {
      targetSession: "nonexistent",
      payload: {},
    });
    const res = (await router.dispatch(req, () => {}, {})) as JsonRpcResponse;
    expect(res.error?.code).toBe(-32004);
  });
});
```

- [ ] **Step 3: Run (fails)**

Run: `make test-file F=packages/server/__tests__/channel-deliver.test.ts`
Expected: FAIL ("Cannot find module ../handlers/channel.js").

- [ ] **Step 4: Implement the handler**

Create `packages/server/handlers/channel.ts`:

```ts
import { Router } from "../router.js";
import type { AppContext } from "../../core/app.js";
import { extract } from "../validate.js";
import { resolveTenantApp } from "./scope-helpers.js";
import { ErrorCodes, RpcError } from "../../protocol/types.js";

export function registerChannelHandlers(router: Router, app: AppContext): void {
  router.handle("channel/deliver", async (params, _notify, ctx) => {
    const opts = extract<{ targetSession: string; payload: unknown }>(params, [
      "targetSession",
      "payload",
    ]);
    const scoped = resolveTenantApp(app, ctx);
    const session = await scoped.sessions.read(opts.targetSession);
    if (!session) {
      throw new RpcError("unknown session", -32004);
    }
    scoped.channelBus.deliver(opts.targetSession, opts.payload);
    return { ok: true };
  });
}
```

Note: the exact accessor for the channel-bus is whatever the existing REST handler uses. Cross-reference and match.

- [ ] **Step 5: Wire registration**

In `packages/server/register.ts`:

```ts
import { registerChannelHandlers } from "./handlers/channel.js";
// inside registerAllHandlers:
registerChannelHandlers(router, app);
```

- [ ] **Step 6: Add `WORKER_NOT_REGISTERED` and `UNKNOWN_SESSION` to error codes if not already**

Run: `grep -n "WORKER_NOT_REGISTERED\|UNKNOWN_SESSION" packages/protocol/types.ts`
If absent, add to the `ErrorCodes` enum in `packages/protocol/types.ts`:

```ts
WORKER_NOT_REGISTERED: -32003,
UNKNOWN_SESSION: -32004,
```

Then update the `worker/heartbeat` and `channel/deliver` handlers from earlier tasks to throw `RpcError("...", ErrorCodes.WORKER_NOT_REGISTERED)` and `RpcError("...", ErrorCodes.UNKNOWN_SESSION)` respectively, replacing the bare numbers `-32003` / `-32004`.

- [ ] **Step 7: Run tests (pass)**

Run: `make test-file F=packages/server/__tests__/channel-deliver.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(server): add channel/deliver JSON-RPC handler + named error codes"
```

### Task B5: `channel/relay` handler + test

**Files:**
- Modify: `packages/server/handlers/channel.ts`
- Modify: `packages/server/__tests__/channel-deliver.test.ts` (add new describe block, OR create `channel-relay.test.ts`)

- [ ] **Step 1: Locate existing REST relay implementation**

Run: `grep -rn "channel/relay\|/api/relay" packages/core/conductor/`
Expected: find the REST handler.

- [ ] **Step 2: Write failing test**

```ts
describe("channel/relay", () => {
  it("relays a message between sessions via the channel bus", async () => {
    const a = await app.sessions.create({ summary: "relay-src" });
    const b = await app.sessions.create({ summary: "relay-dst" });
    const received: unknown[] = [];
    const unsub = app.channelBus.subscribe(b.id, (m) => received.push(m));
    try {
      const req = createRequest("channel/relay", {
        fromSession: a.id,
        toSession: b.id,
        payload: { hello: "world" },
      });
      const res = (await router.dispatch(req, () => {}, {})) as JsonRpcResponse;
      expect(res.result).toBeDefined();
      expect(received).toHaveLength(1);
    } finally {
      unsub();
    }
  });
});
```

- [ ] **Step 3: Run (fails)**

Run: `make test-file F=packages/server/__tests__/channel-deliver.test.ts`
Expected: FAIL.

- [ ] **Step 4: Implement handler**

Add to `packages/server/handlers/channel.ts`:

```ts
router.handle("channel/relay", async (params, _notify, ctx) => {
  const opts = extract<{
    fromSession: string;
    toSession: string;
    payload: unknown;
  }>(params, ["fromSession", "toSession", "payload"]);
  const scoped = resolveTenantApp(app, ctx);
  const target = await scoped.sessions.read(opts.toSession);
  if (!target) {
    throw new RpcError("unknown target session", ErrorCodes.UNKNOWN_SESSION);
  }
  scoped.channelBus.relay(opts.fromSession, opts.toSession, opts.payload);
  return { ok: true };
});
```

(Match the actual relay method signature on the channel bus - inspect first.)

- [ ] **Step 5: Run + commit**

```bash
make test-file F=packages/server/__tests__/channel-deliver.test.ts
git add -A
git commit -m "feat(server): add channel/relay JSON-RPC handler"
```

### Task B6: `hook/forward` handler + test

**Files:**
- Create: `packages/server/handlers/hook.ts`
- Create: `packages/server/__tests__/hook-forward.test.ts`
- Modify: `packages/server/register.ts`

- [ ] **Step 1: Locate existing REST hook-forward implementation**

Run: `grep -rn "hook/forward\|/hooks/forward\|hookForward" packages/core/conductor/`
Expected: find handler that accepts hook events from arkd and routes to event bus / persistence.

- [ ] **Step 2: Write failing test**

Create `packages/server/__tests__/hook-forward.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { AppContext } from "../../core/app.js";
import { registerHookHandlers } from "../handlers/hook.js";
import { Router } from "../router.js";
import { createRequest, type JsonRpcResponse } from "../../protocol/types.js";
import { eventBus } from "../../core/hooks.js";

let app: AppContext;
let router: Router;

beforeAll(async () => {
  app = await AppContext.forTestAsync();
  await app.boot();
});

afterAll(async () => {
  await app?.shutdown();
  eventBus.clear();
});

beforeEach(() => {
  router = new Router();
  registerHookHandlers(router, app);
});

describe("hook/forward", () => {
  it("routes a hook event through the event bus", async () => {
    const session = await app.sessions.create({ summary: "hook-target" });
    const events: unknown[] = [];
    eventBus.on("hook_status", (e: unknown) => events.push(e));
    const req = createRequest("hook/forward", {
      sessionId: session.id,
      event: { type: "PreToolUse", tool: "Bash", payload: {} },
    });
    const res = (await router.dispatch(req, () => {}, {})) as JsonRpcResponse;
    expect(res.result).toBeDefined();
    // Hook pipeline emits at least one event
    expect(events.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 3: Run (fails)**

Run: `make test-file F=packages/server/__tests__/hook-forward.test.ts`
Expected: FAIL.

- [ ] **Step 4: Implement handler**

Create `packages/server/handlers/hook.ts`:

```ts
import { Router } from "../router.js";
import type { AppContext } from "../../core/app.js";
import { extract } from "../validate.js";
import { resolveTenantApp } from "./scope-helpers.js";

export function registerHookHandlers(router: Router, app: AppContext): void {
  router.handle("hook/forward", async (params, _notify, ctx) => {
    const opts = extract<{ sessionId: string; event: Record<string, unknown> }>(params, [
      "sessionId",
      "event",
    ]);
    const scoped = resolveTenantApp(app, ctx);
    // Reuse existing report-pipeline. Find the call site in
    // packages/core/conductor/server/report-pipeline.ts and call its
    // entry function directly here.
    await scoped.reportPipeline.ingest(opts.sessionId, opts.event);
    return { ok: true };
  });
}
```

(The actual accessor for the report pipeline depends on how AppContext exposes it. Match the existing REST handler's call site.)

- [ ] **Step 5: Wire registration**

In `packages/server/register.ts`:

```ts
import { registerHookHandlers } from "./handlers/hook.js";
// inside registerAllHandlers:
registerHookHandlers(router, app);
```

- [ ] **Step 6: Run + commit**

```bash
make test-file F=packages/server/__tests__/hook-forward.test.ts
git add -A
git commit -m "feat(server): add hook/forward JSON-RPC handler"
```

### Task B7: `session/tree-stream` subscription handler + test

This is the SSE replacement: server-push of tree updates over the JSON-RPC `notify` channel.

**Files:**
- Modify: `packages/server/handlers/session.ts`
- Create: `packages/server/__tests__/session-tree-stream.test.ts`

- [ ] **Step 1: Locate the existing SSE implementation**

Run: `grep -rn "tree/stream\|tree-update\|treeUpdate" packages/core/conductor/`
Expected: find the SSE handler in `packages/core/conductor/server/`.

- [ ] **Step 2: Write failing test**

Create `packages/server/__tests__/session-tree-stream.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { AppContext } from "../../core/app.js";
import { registerSessionHandlers } from "../handlers/session.js";
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
  registerSessionHandlers(router, app);
});

describe("session/tree-stream", () => {
  it("returns initial state and pushes notifications on tree change", async () => {
    const root = await app.sessions.create({ summary: "tree-root" });
    const notifications: Array<{ method: string; params: unknown }> = [];
    const notify = (method: string, params: unknown) => {
      notifications.push({ method, params });
    };
    // Subscribe
    const sub = createRequest("session/tree-stream", { sessionId: root.id });
    const res = (await router.dispatch(sub, notify, {})) as JsonRpcResponse;
    expect(res.result).toBeDefined();
    // Trigger a tree change: add a child
    const child = await app.sessions.create({ summary: "tree-child" });
    await app.sessions.update(child.id, { parent_id: root.id });
    // Drain - the notification should have arrived synchronously (channel bus
    // is in-process). If not, give the event loop a turn:
    await new Promise((r) => setTimeout(r, 10));
    expect(notifications.length).toBeGreaterThan(0);
    expect(notifications.some((n) => n.method === "session/tree-update")).toBe(true);
  });

  it("cleans up subscription on connection close (no listener leak)", async () => {
    const root = await app.sessions.create({ summary: "tree-cleanup-root" });
    // Count listeners before
    const before = app.sessionTreeBus.listenerCount(root.id);
    // Subscribe
    const sub = createRequest("session/tree-stream", { sessionId: root.id });
    const dispatch = await router.dispatch(sub, () => {}, {});
    expect((dispatch as JsonRpcResponse).result).toBeDefined();
    // The Router/connection close hook fires when ctx.close() runs.
    // Simulate by calling the close hook returned from dispatch (if exposed)
    // OR by closing the underlying ctx. The exact mechanism here depends on
    // Router internals - cross-reference how other subscription handlers do it.
    // After close:
    const after = app.sessionTreeBus.listenerCount(root.id);
    expect(after).toBe(before);
  });
});
```

(The cleanup test depends on the Router exposing a close hook. If the existing pattern uses a different mechanism, adjust to match - for example, some implementations register cleanup via `ctx.onClose(() => ...)`. Cross-reference an existing subscription handler in `packages/server/handlers/` if one exists; otherwise the cleanup needs to be added as part of this task.)

- [ ] **Step 3: Run (fails)**

Run: `make test-file F=packages/server/__tests__/session-tree-stream.test.ts`
Expected: FAIL.

- [ ] **Step 4: Implement the subscription handler**

In `packages/server/handlers/session.ts`, inside `registerSessionHandlers`:

```ts
router.handle("session/tree-stream", async (params, notify, ctx) => {
  const opts = extract<{ sessionId: string }>(params, ["sessionId"]);
  const scoped = resolveTenantApp(app, ctx);
  // Get initial state
  const tree = await scoped.sessions.readTree(opts.sessionId);
  // Subscribe to subsequent changes
  const unsubscribe = scoped.sessionTreeBus.subscribe(opts.sessionId, (delta: unknown) => {
    notify("session/tree-update", { sessionId: opts.sessionId, delta });
  });
  // Register cleanup on connection close. The exact API for this depends on
  // how the existing Router handles per-connection cleanup. Use the same
  // pattern as any other subscription handler. If none exists yet, this
  // task adds it: extend the handler context with a `ctx.onClose(fn)`
  // hook and have the WS upgrade path invoke registered close handlers
  // when the connection drops.
  ctx.onClose?.(unsubscribe);
  return { tree };
});
```

If `ctx.onClose` doesn't exist yet on the context type, this task includes adding it: extend `packages/server/router.ts` (or the equivalent context shape) with an `onClose` callback array, and call it from the WS close handler in the launcher / `ArkServer`.

- [ ] **Step 5: Run + commit**

```bash
make test-file F=packages/server/__tests__/session-tree-stream.test.ts
git add -A
git commit -m "feat(server): add session/tree-stream subscription with notify-based push"
```

### Task B8: `session/forensics/stdio` and `session/forensics/transcript` handlers + tests

**Files:**
- Modify: `packages/server/handlers/session.ts`
- Create: `packages/server/__tests__/session-forensics.test.ts`

- [ ] **Step 1: Locate existing REST forensics handlers**

Run: `grep -rn "forensics\|/api/sessions/.*/stdio\|/api/sessions/.*/transcript" packages/core/conductor/`
Expected: find the REST handlers that read stdio.log and transcript files.

- [ ] **Step 2: Write failing test**

```ts
// packages/server/__tests__/session-forensics.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { AppContext } from "../../core/app.js";
import { registerSessionHandlers } from "../handlers/session.js";
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
  registerSessionHandlers(router, app);
});

describe("session/forensics", () => {
  it("returns stdio for a session that has tracks written", async () => {
    const session = await app.sessions.create({ summary: "forensics" });
    // Seed: write a fake stdio.log under tracks/<sid>/
    await scoped.tracks.writeStdio(session.id, "hello\n"); // placeholder, use real API
    const req = createRequest("session/forensics/stdio", { sessionId: session.id });
    const res = (await router.dispatch(req, () => {}, {})) as JsonRpcResponse;
    const result = res.result as { content: string };
    expect(result.content).toContain("hello");
  });
});
```

(Replace `scoped.tracks.writeStdio` with however the test fixture today writes seed stdio - cross-reference an existing forensics test if one exists.)

- [ ] **Step 3: Run (fails)**

Run: `make test-file F=packages/server/__tests__/session-forensics.test.ts`
Expected: FAIL.

- [ ] **Step 4: Implement handlers**

In `packages/server/handlers/session.ts`:

```ts
router.handle("session/forensics/stdio", async (params, _notify, ctx) => {
  const opts = extract<{ sessionId: string }>(params, ["sessionId"]);
  const scoped = resolveTenantApp(app, ctx);
  const content = await scoped.tracks.readStdio(opts.sessionId);
  return { content };
});

router.handle("session/forensics/transcript", async (params, _notify, ctx) => {
  const opts = extract<{ sessionId: string }>(params, ["sessionId"]);
  const scoped = resolveTenantApp(app, ctx);
  const content = await scoped.tracks.readTranscript(opts.sessionId);
  return { content };
});
```

(Match the actual track-reader API; the existing REST handlers will show the right method names.)

- [ ] **Step 5: Run + commit**

```bash
make test-file F=packages/server/__tests__/session-forensics.test.ts
git add -A
git commit -m "feat(server): add session/forensics/{stdio,transcript} handlers"
```

### Task B9: `terminal/subscribe` and `terminal/input` handlers + tests

The terminal WS at `/terminal/:sessionId` stays as-is (raw bidi WS). These methods are for the JSON-RPC channel that orchestrates terminal attach FROM the conductor side - the conductor asks arkd over JSON-RPC to subscribe a terminal stream and forwards the frames to the requesting client via `notify`. This replaces the per-attach HTTP chunked stream pull model.

**Files:**
- Create: `packages/server/handlers/terminal.ts`
- Create: `packages/server/__tests__/terminal-rpc.test.ts`
- Modify: `packages/server/register.ts`

- [ ] **Step 1: Find existing terminal-attach orchestration**

Run: `grep -rn "attachStream\|attach_open\|terminalSubscribe" packages/core/conductor/ packages/server/ packages/arkd/`
Expected: identify the current flow (likely `arkdClient.attachStream(handle)`).

- [ ] **Step 2: Write failing test**

Create `packages/server/__tests__/terminal-rpc.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { AppContext } from "../../core/app.js";
import { registerTerminalHandlers } from "../handlers/terminal.js";
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
  registerTerminalHandlers(router, app);
});

describe("terminal/subscribe", () => {
  it("returns a handle for an attach subscription", async () => {
    const session = await app.sessions.create({ summary: "term-1" });
    const req = createRequest("terminal/subscribe", { sessionId: session.id });
    const res = (await router.dispatch(req, () => {}, {})) as JsonRpcResponse;
    const result = res.result as { handle: string };
    expect(typeof result.handle).toBe("string");
  });
});
```

- [ ] **Step 3: Run (fails)**

Run: `make test-file F=packages/server/__tests__/terminal-rpc.test.ts`
Expected: FAIL.

- [ ] **Step 4: Implement handler**

Create `packages/server/handlers/terminal.ts`:

```ts
import { Router } from "../router.js";
import type { AppContext } from "../../core/app.js";
import { extract } from "../validate.js";
import { resolveTenantApp } from "./scope-helpers.js";

export function registerTerminalHandlers(router: Router, app: AppContext): void {
  router.handle("terminal/subscribe", async (params, notify, ctx) => {
    const opts = extract<{ sessionId: string }>(params, ["sessionId"]);
    const scoped = resolveTenantApp(app, ctx);
    // Open attach against the session's arkd via existing client
    const handle = await scoped.terminalService.subscribe(opts.sessionId, (frame: Uint8Array) => {
      notify("terminal/frame", {
        sessionId: opts.sessionId,
        bytes: Buffer.from(frame).toString("base64"),
      });
    });
    ctx.onClose?.(() => scoped.terminalService.unsubscribe(handle));
    return { handle };
  });

  router.handle("terminal/input", async (params, _notify, ctx) => {
    const opts = extract<{ handle: string; bytes: string }>(params, ["handle", "bytes"]);
    const scoped = resolveTenantApp(app, ctx);
    await scoped.terminalService.input(opts.handle, Buffer.from(opts.bytes, "base64"));
    return { ok: true };
  });
}
```

(`scoped.terminalService` is whatever wraps the existing attach machinery in arkd's client. If no facade exists yet, this task creates a thin one in `packages/core/services/terminal.ts` that wraps `arkdClient.attachStream` etc.)

- [ ] **Step 5: Wire registration**

In `packages/server/register.ts`:

```ts
import { registerTerminalHandlers } from "./handlers/terminal.js";
// inside registerAllHandlers:
registerTerminalHandlers(router, app);
```

- [ ] **Step 6: Run + commit**

```bash
make test-file F=packages/server/__tests__/terminal-rpc.test.ts
git add -A
git commit -m "feat(server): add terminal/subscribe + terminal/input JSON-RPC handlers"
```

### Task B10: `log/subscribe` handler + test

**Files:**
- Modify: `packages/server/handlers/session.ts` (logs are session-scoped)
- Create: `packages/server/__tests__/log-subscribe.test.ts`

- [ ] **Step 1: Locate existing log-tail mechanism**

Run: `grep -rn "log_chunk\|logTail\|tracks.*log" packages/`
Expected: find how logs are tailed today.

- [ ] **Step 2: Write failing test**

```ts
// packages/server/__tests__/log-subscribe.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { AppContext } from "../../core/app.js";
import { registerSessionHandlers } from "../handlers/session.js";
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
  registerSessionHandlers(router, app);
});

describe("log/subscribe", () => {
  it("returns existing log content and pushes appended chunks", async () => {
    const session = await app.sessions.create({ summary: "log-1" });
    const notifications: Array<{ method: string; params: unknown }> = [];
    const notify = (method: string, params: unknown) => {
      notifications.push({ method, params });
    };
    const req = createRequest("log/subscribe", { sessionId: session.id, file: "stdio" });
    const res = (await router.dispatch(req, notify, {})) as JsonRpcResponse;
    expect(res.result).toBeDefined();
    // Append to the log
    await app.tracks.appendStdio(session.id, "new line\n");
    await new Promise((r) => setTimeout(r, 50));
    expect(notifications.some((n) => n.method === "log/chunk")).toBe(true);
  });
});
```

- [ ] **Step 3: Run (fails)**

Run: `make test-file F=packages/server/__tests__/log-subscribe.test.ts`
Expected: FAIL.

- [ ] **Step 4: Implement handler**

In `packages/server/handlers/session.ts`:

```ts
router.handle("log/subscribe", async (params, notify, ctx) => {
  const opts = extract<{ sessionId: string; file: "stdio" | "transcript" }>(params, [
    "sessionId",
    "file",
  ]);
  const scoped = resolveTenantApp(app, ctx);
  const initial = await scoped.tracks.read(opts.sessionId, opts.file);
  const unsubscribe = scoped.tracks.tail(opts.sessionId, opts.file, (chunk: Buffer) => {
    notify("log/chunk", {
      sessionId: opts.sessionId,
      file: opts.file,
      bytes: chunk.toString("base64"),
    });
  });
  ctx.onClose?.(unsubscribe);
  return { initial };
});
```

(Adjust to match the actual `tracks` API; cross-reference existing tail implementations.)

- [ ] **Step 5: Run + commit**

```bash
make test-file F=packages/server/__tests__/log-subscribe.test.ts
git add -A
git commit -m "feat(server): add log/subscribe JSON-RPC handler"
```

### Task B11: Auth role gating

Add per-method role enforcement: a worker token cannot call user-only methods, and vice versa.

**Files:**
- Modify: `packages/server/router.ts` (or wherever auth context is resolved per-call)
- Modify: relevant handler files to declare required roles
- Create: `packages/server/__tests__/auth-role-gating.test.ts`

- [ ] **Step 1: Locate the auth resolver in the request path**

Run: `grep -n "TenantContext\|resolveTenant\|apiKeys.validate" packages/server/`
Expected: find where token -> identity -> ctx happens on each call.

- [ ] **Step 2: Decide on the role declaration mechanism**

Two reasonable patterns:
- (a) A second arg to `router.handle()` that lists allowed roles: `router.handle("worker/heartbeat", { roles: ["worker"] }, async (...) => {...})`.
- (b) A method-name-prefix convention: `worker/*` requires `worker` role, `admin/*` requires `admin`, everything else requires `user`.

Pick (b) if the codebase already names methods with consistent prefixes (it does - `worker/`, `admin/`, otherwise user). Implement in the auth resolver: resolve the role from the token, then check `methodName.split("/")[0]` against allowed roles for that token.

- [ ] **Step 3: Write failing test**

```ts
// packages/server/__tests__/auth-role-gating.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { AppContext } from "../../core/app.js";
import { registerAllHandlers } from "../register.js"; // or wherever
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
  registerAllHandlers(router, app);
});

describe("auth role gating", () => {
  it("rejects worker/* from a user token", async () => {
    const userCtx = { role: "user", tenantId: "default" };
    const req = createRequest("worker/heartbeat", { computeId: "x" });
    const res = (await router.dispatch(req, () => {}, userCtx)) as JsonRpcResponse;
    expect(res.error?.code).toBe(-32001);
  });

  it("rejects user-only methods from a worker token", async () => {
    const workerCtx = { role: "worker", tenantId: "default" };
    const req = createRequest("session/start", { flow: "noop" });
    const res = (await router.dispatch(req, () => {}, workerCtx)) as JsonRpcResponse;
    expect(res.error?.code).toBe(-32001);
  });
});
```

- [ ] **Step 4: Run (fails)**

Run: `make test-file F=packages/server/__tests__/auth-role-gating.test.ts`
Expected: FAIL (no gating yet).

- [ ] **Step 5: Implement gating**

In `packages/server/router.ts`'s dispatch (or in the auth resolver wrapping it):

```ts
const ROLE_PREFIXES: Record<string, string[]> = {
  worker: ["worker"],
  admin: ["admin", "user", "worker"], // admin can do everything
  user: ["session", "flow", "agent", "compute", "input", "config", "messaging",
         "metrics", "secrets", "connectors", "tools", "triggers", "webhooks",
         "schedule", "fs", "dashboard", "daemon"],
};

function methodAllowedForRole(method: string, role: string): boolean {
  const prefix = method.split("/")[0];
  const allowed = ROLE_PREFIXES[role] ?? [];
  return allowed.includes(prefix);
}
```

Then in dispatch, before invoking the handler:

```ts
if (!methodAllowedForRole(req.method, ctx.role)) {
  return { jsonrpc: "2.0", id: req.id, error: { code: -32001, message: "forbidden" } };
}
```

Define `FORBIDDEN: -32001` in `ErrorCodes`.

- [ ] **Step 6: Run (passes)**

Run: `make test-file F=packages/server/__tests__/auth-role-gating.test.ts`
Expected: PASS.

- [ ] **Step 7: Confirm no other tests broke**

Run: `make test`
Expected: all pass. If any test fails because it didn't supply a role, fix the test fixture to set `ctx.role = "user"` (or whatever the test models).

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(server): per-method role gating via method-prefix convention"
```

### Task B12: Phase B end-of-phase verification

- [ ] **Step 1: Full test suite**

Run: `make test`
Expected: all pass.

- [ ] **Step 2: Lint**

Run: `make lint`
Expected: zero warnings.

- [ ] **Step 3: Format check**

Run: `make format`
Expected: no diffs (or apply fixes and amend).

---

## Phase C: ArkClient extensions

Add the worker-facing methods to `packages/protocol/`'s `ArkClient` so callers (arkd, web, CLI) can invoke them. This phase does not yet switch any caller - it just makes the methods available.

### Task C1: Add worker methods to ArkClient

**Files:**
- Modify: `packages/protocol/client.ts`
- Modify: `packages/protocol/rpc-schemas.ts`

- [ ] **Step 1: Locate ArkClient's existing method patterns**

Run: `head -120 packages/protocol/client.ts`
Identify how an existing method (e.g. `sessionStart`) is declared and how it calls into the JSON-RPC transport.

- [ ] **Step 2: Add types for worker methods to rpc-schemas**

In `packages/protocol/rpc-schemas.ts`:

```ts
export interface WorkerRegisterParams {
  computeId: string;
  capabilities?: Record<string, unknown>;
}
export interface WorkerRegisterResult {
  workerId: string;
}
export interface WorkerHeartbeatParams {
  computeId: string;
}
export interface WorkerHeartbeatResult {
  ok: boolean;
}
// ... and similarly for deregister, list
```

- [ ] **Step 3: Add methods to ArkClient**

In `packages/protocol/client.ts`:

```ts
async workerRegister(params: WorkerRegisterParams): Promise<WorkerRegisterResult> {
  return this.call("worker/register", params);
}
async workerHeartbeat(params: WorkerHeartbeatParams): Promise<WorkerHeartbeatResult> {
  return this.call("worker/heartbeat", params);
}
async workerDeregister(params: WorkerHeartbeatParams): Promise<{ ok: true }> {
  return this.call("worker/deregister", params);
}
async workerList(): Promise<{ workers: Array<{ computeId: string }> }> {
  return this.call("worker/list", {});
}
```

(Match the `this.call(...)` shape used by existing methods.)

- [ ] **Step 4: Type-check**

Run: `bun x tsc --noEmit`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add packages/protocol/
git commit -m "feat(protocol): add worker/* methods to ArkClient"
```

### Task C2: Add channel + hook methods to ArkClient

**Files:**
- Modify: `packages/protocol/client.ts`
- Modify: `packages/protocol/rpc-schemas.ts`

- [ ] **Step 1: Add types**

```ts
export interface ChannelDeliverParams {
  targetSession: string;
  payload: unknown;
}
export interface ChannelRelayParams {
  fromSession: string;
  toSession: string;
  payload: unknown;
}
export interface HookForwardParams {
  sessionId: string;
  event: Record<string, unknown>;
}
```

- [ ] **Step 2: Add methods**

```ts
async channelDeliver(params: ChannelDeliverParams): Promise<{ ok: true }> {
  return this.call("channel/deliver", params);
}
async channelRelay(params: ChannelRelayParams): Promise<{ ok: true }> {
  return this.call("channel/relay", params);
}
async hookForward(params: HookForwardParams): Promise<{ ok: true }> {
  return this.call("hook/forward", params);
}
```

- [ ] **Step 3: Type-check + commit**

```bash
bun x tsc --noEmit
git add packages/protocol/
git commit -m "feat(protocol): add channel/* and hook/forward methods to ArkClient"
```

### Task C3: Add subscription methods (tree, terminal, log) to ArkClient

These are subscriptions: they call the method, get an initial result, AND register a notification handler.

**Files:**
- Modify: `packages/protocol/client.ts`
- Modify: `packages/protocol/rpc-schemas.ts`

- [ ] **Step 1: Find an existing subscription method on ArkClient (if any)**

Run: `grep -n "notify\|subscribe\|onNotification" packages/protocol/client.ts`
Identify the existing pattern.

- [ ] **Step 2: Add subscription methods**

```ts
async sessionTreeStream(
  sessionId: string,
  onUpdate: (delta: unknown) => void,
): Promise<{ tree: unknown; unsubscribe: () => void }> {
  const handler = (notif: { method: string; params: unknown }) => {
    if (notif.method === "session/tree-update") {
      onUpdate((notif.params as { delta: unknown }).delta);
    }
  };
  this.onNotification(handler);
  const result = await this.call("session/tree-stream", { sessionId });
  return {
    tree: (result as { tree: unknown }).tree,
    unsubscribe: () => this.offNotification(handler),
  };
}

async terminalSubscribe(
  sessionId: string,
  onFrame: (bytes: Buffer) => void,
): Promise<{ handle: string; unsubscribe: () => void }> {
  const handler = (notif: { method: string; params: unknown }) => {
    if (notif.method === "terminal/frame") {
      const p = notif.params as { sessionId: string; bytes: string };
      if (p.sessionId === sessionId) {
        onFrame(Buffer.from(p.bytes, "base64"));
      }
    }
  };
  this.onNotification(handler);
  const result = await this.call("terminal/subscribe", { sessionId });
  return {
    handle: (result as { handle: string }).handle,
    unsubscribe: () => this.offNotification(handler),
  };
}

async logSubscribe(
  sessionId: string,
  file: "stdio" | "transcript",
  onChunk: (bytes: Buffer) => void,
): Promise<{ initial: string; unsubscribe: () => void }> {
  const handler = (notif: { method: string; params: unknown }) => {
    if (notif.method === "log/chunk") {
      const p = notif.params as { sessionId: string; file: string; bytes: string };
      if (p.sessionId === sessionId && p.file === file) {
        onChunk(Buffer.from(p.bytes, "base64"));
      }
    }
  };
  this.onNotification(handler);
  const result = await this.call("log/subscribe", { sessionId, file });
  return {
    initial: (result as { initial: string }).initial,
    unsubscribe: () => this.offNotification(handler),
  };
}
```

If `onNotification` / `offNotification` don't exist yet on ArkClient, this task adds them (a standard observer pattern: a Set<Handler> on the client, the WS message dispatch fires every notification through registered handlers).

- [ ] **Step 3: Type-check + commit**

```bash
bun x tsc --noEmit
git add packages/protocol/
git commit -m "feat(protocol): add tree/terminal/log subscription methods to ArkClient"
```

---

## Phase D: Switch callers to new endpoints

### Task D1: Switch arkd client from REST to ArkClient (worker methods)

**Files:**
- Modify: `packages/arkd/client/client.ts` (the existing 348-LOC client - look up its actual filename)
- Modify: `packages/arkd/server/control-plane.ts` (the heartbeat loop) or wherever heartbeats originate
- Modify: `packages/arkd/__tests__/` test files that touch the client

- [ ] **Step 1: Identify arkd's call sites against the conductor**

Run: `grep -rn "fetch\|post\|http://" packages/arkd/server/control-plane.ts packages/arkd/server/`
List every place arkd POSTs to the conductor.

- [ ] **Step 2: Replace REST calls with ArkClient calls**

Construct an `ArkClient` instance in arkd's boot path with worker-token auth. Replace each `fetch(...)` to the conductor with the typed `arkdClient.workerHeartbeat(...)`, `arkdClient.hookForward(...)`, `arkdClient.channelDeliver(...)`, `arkdClient.channelRelay(...)` etc.

- [ ] **Step 3: Update heartbeat loop**

The existing per-call HTTP POST becomes a single persistent WS that re-uses the connection across heartbeats. The loop just calls `arkdClient.workerHeartbeat(...)` on its timer; ArkClient handles the underlying WS.

On reconnect, ArkClient should re-issue `worker/register` (the auth handshake) before resuming. If ArkClient doesn't have a hook for "on reconnect, do X", add one as part of this task or layer the re-register at the arkd-side via a reconnect callback.

- [ ] **Step 4: Run arkd-related tests**

Run: `make test-file F=packages/arkd/__tests__/control-plane.test.ts` (or whichever tests cover the heartbeat path)
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/arkd/
git commit -m "refactor(arkd): swap REST control-plane client for ArkClient over WS"
```

### Task D2: Switch web UI's SSE consumer to JSON-RPC subscription

**Files:**
- Modify: `packages/web/` (find the SSE consumer)

- [ ] **Step 1: Find the SSE consumer**

Run: `grep -rn "EventSource\|tree/stream" packages/web/`
Expected: find where the web UI opens an SSE connection for session tree updates.

- [ ] **Step 2: Replace EventSource with ArkClient subscription**

Where the SSE is opened (typically in a React effect or a store), replace:

```tsx
const es = new EventSource(`${conductorUrl}/api/sessions/${sessionId}/tree/stream`);
es.onmessage = (e) => { ... };
return () => es.close();
```

With:

```tsx
let unsubscribe: (() => void) | null = null;
arkClient.sessionTreeStream(sessionId, (delta) => { ... applyDelta ... })
  .then(({ tree, unsubscribe: u }) => {
    applyInitialTree(tree);
    unsubscribe = u;
  });
return () => { unsubscribe?.(); };
```

- [ ] **Step 3: Run any web-related tests**

Run: `make test-file F=packages/web/__tests__/<relevant>.test.ts` if such a test exists. Otherwise, skip.

- [ ] **Step 4: Manually verify in dev**

Run: `make dev`
Open: http://localhost:8420
Verify: session tree updates as expected (start a session, watch the tree populate).

- [ ] **Step 5: Commit**

```bash
git add packages/web/
git commit -m "refactor(web): swap session-tree SSE for JSON-RPC subscription"
```

### Task D3: Update ArkdLauncher conductorUrl

**Files:**
- Modify: `packages/core/infra/arkd-launcher.ts`

- [ ] **Step 1: Edit the URL template**

The current:

```ts
const conductorUrl = `http://localhost:${this.config.ports.conductor}`;
```

Two changes:
1. The `ports.conductor` identifier already points at the merged port (19400) after Phase A's rename. The identifier name is unchanged; only the value moved from 19100 to 19400.
2. The scheme changes from `http://` to `ws://` because arkd's control-plane client now uses ArkClient over WebSocket (per Task D1) instead of REST.

Update to:

```ts
const conductorUrl = `ws://localhost:${this.config.ports.conductor}`;
```

If anywhere in the same file you find a separate `httpUrl` or REST-only base URL still being assembled, delete it - all internal arkd<->conductor traffic is now WS.

- [ ] **Step 2: Run tests**

Run: `make test`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/core/infra/arkd-launcher.ts
git commit -m "fix(arkd-launcher): point at merged port via ws:// scheme"
```

### Task D4: Update compute adapters' conductor URL injection

**Files:**
- Modify: `packages/compute/core/ec2.ts`
- Modify: `packages/compute/core/local.ts`
- Modify: any other `packages/compute/core/*.ts` that injects the conductor URL

- [ ] **Step 1: Grep for conductor URL injection**

Run: `grep -rn "ARK_CONDUCTOR_URL\|conductorUrl\|ports.conductor\|19100" packages/compute/`
Expected: list every place the URL is built.

- [ ] **Step 2: Update each match**

Replace any `:19100` literal with the merged port value or a config read. Replace `http://` schemes with `ws://` for the control-plane URL (matching D3). Leave HTTP-only paths alone if any (none after merge - everything internal is WS).

- [ ] **Step 3: Run compute-related tests**

Run: `make test-file F=packages/compute/__tests__/<relevant>.test.ts` for each adapter you touched.

- [ ] **Step 4: Commit**

```bash
git add packages/compute/
git commit -m "fix(compute): point compute adapters at merged conductor port (ws://)"
```

---

## Phase E: Rip out the old conductor REST surface

Now that everything routes through the new JSON-RPC handlers, the old REST surface can delete.

### Task E1: Delete `packages/core/conductor/`

**Files:**
- Delete: entire `packages/core/conductor/` subdirectory

- [ ] **Step 1: Find every importer outside the deleted directory**

Run: `grep -rn "from \"\.\./\.\./core/conductor\|from \"\.\./conductor\"" packages/ --include="*.ts"`
Expected: list of imports that need to go away or move.

- [ ] **Step 2: For each importer, replace the import**

If the import was for a function that's now a JSON-RPC handler, update the caller to use ArkClient instead. If it was for a type, move the type to `packages/core/types/` or `packages/protocol/rpc-schemas.ts`. If it was for utility logic (e.g. report-pipeline internals), move that file to `packages/core/services/` or wherever it logically belongs.

- [ ] **Step 3: Delete the directory**

```bash
rm -rf packages/core/conductor/
```

- [ ] **Step 4: Type-check**

Run: `bun x tsc --noEmit`
Expected: clean. Fix any dangling references.

- [ ] **Step 5: Run tests**

Run: `make test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor(core): delete packages/core/conductor/ -- merged into server"
```

### Task E2: Delete `ConductorLauncher` and remove second Bun.serve

**Files:**
- Delete: `packages/core/infra/conductor-launcher.ts`
- Modify: `packages/core/app.ts` (remove `ConductorLauncher` reference)
- Modify: `packages/core/container.ts` (remove DI registration)
- Modify: `packages/core/lifecycle.ts` (remove from boot order)

- [ ] **Step 1: Find every reference**

Run: `grep -rn "ConductorLauncher\|conductor-launcher" packages/`
Expected: list of references to delete or update.

- [ ] **Step 2: Remove DI registration**

In `packages/core/container.ts`:

```ts
// delete the registration of conductorLauncher
```

- [ ] **Step 3: Remove from lifecycle**

In `packages/core/lifecycle.ts`, remove `conductorLauncher` from the boot/dispose order.

- [ ] **Step 4: Remove from app.ts**

In `packages/core/app.ts`:

```ts
// delete `app.conductorLauncher = ...` and any references
```

- [ ] **Step 5: Delete the file**

```bash
rm packages/core/infra/conductor-launcher.ts
```

- [ ] **Step 6: Type-check + commit**

```bash
bun x tsc --noEmit
git add -A
git commit -m "refactor(infra): delete ConductorLauncher; merged conductor uses single launcher"
```

### Task E3: Delete the JSON-RPC bridge handler `handlers/conductor.ts`

**Files:**
- Delete: `packages/server/handlers/conductor.ts`
- Modify: `packages/server/register.ts` (remove the registration call)

- [ ] **Step 1: Confirm no other code references the bridge methods**

Run: `grep -rn "conductor/status\|conductor/bridge\|conductor/notify" packages/`
Expected: only the handler file itself + maybe `register.ts`.

If callers exist (e.g. CLI commands using `conductor/status` for daemon status reporting), migrate them: rename the methods to `daemon/status` if they were used for the daemon status command, or replace with whatever survived after the daemon-command consolidation in Phase G.

- [ ] **Step 2: Delete the bridge file**

```bash
rm packages/server/handlers/conductor.ts
```

- [ ] **Step 3: Remove from register.ts**

In `packages/server/register.ts`, delete `registerConductorHandlers` import and its call.

- [ ] **Step 4: Type-check + commit**

```bash
bun x tsc --noEmit
git add -A
git commit -m "refactor(server): delete server/handlers/conductor.ts JSON-RPC bridge"
```

### Task E4: Build the merged launcher (single Bun.serve)

**Files:**
- Create: `packages/server/launcher.ts`
- Modify: `packages/server/index.ts` (replace existing startup with new launcher)
- Modify: `packages/core/app.ts` (boot sequence calls new launcher)

- [ ] **Step 1: Inspect existing launcher code**

Run: `head -200 packages/server/index.ts`
Identify how `ArkServer.startWebSocket(port)` works today.

- [ ] **Step 2: Write the new launcher**

Create `packages/server/launcher.ts`:

```ts
import type { AppContext } from "../core/app.js";
import { ArkServer } from "./index.js"; // adjust if class name differs
import { mountOpenAIProxy } from "./mounts/openai-proxy.js"; // existing
import { mountMcp } from "./mounts/mcp.js"; // existing
import { mountWebhooks } from "./mounts/webhooks.js"; // existing
import { mountTerminalWs } from "./mounts/terminal.js"; // existing

export interface LauncherHandle {
  stop(): void;
}

export function startConductor(app: AppContext, port: number): LauncherHandle {
  const arkServer = new ArkServer(app);
  const server = Bun.serve({
    port,
    fetch(req, srv) {
      const url = new URL(req.url);
      const path = url.pathname;

      // External REST surfaces - dispatch first
      if (path === "/health") return new Response("ok", { status: 200 });
      if (path.startsWith("/v1/")) return mountOpenAIProxy(req, app);
      if (path === "/mcp" || path.startsWith("/mcp/")) return mountMcp(req, app);
      if (path.startsWith("/hooks/")) return mountWebhooks(req, app);
      if (path.startsWith("/terminal/")) return mountTerminalWs(req, srv, app);

      // JSON-RPC over WS - root path with upgrade header
      if (path === "/" && req.headers.get("upgrade")?.toLowerCase() === "websocket") {
        return arkServer.handleUpgrade(req, srv);
      }

      return new Response("not found", { status: 404 });
    },
    websocket: arkServer.websocketHandlers(),
  });
  return {
    stop() {
      server.stop();
      arkServer.close();
    },
  };
}
```

The exact mount-function names depend on how OpenAI proxy / MCP / webhooks / terminal are organized today - inspect the existing `ArkServer.startWebSocket()` implementation and replicate the routing in the new launcher. The goal: ALL paths the old two listeners handled, now in one Bun.serve.

- [ ] **Step 3: Wire into app boot**

In `packages/core/app.ts`, replace the previous double-boot (ConductorLauncher + ArkServer.startWebSocket) with a single call to `startConductor(app, app.config.ports.conductor)`.

- [ ] **Step 4: Run + commit**

```bash
make test
git add -A
git commit -m "feat(server): single Bun.serve launcher hosts all surfaces on conductor port"
```

---

## Phase F: Package rename `packages/server/` -> `packages/conductor/`

Mechanical but touches every importer.

### Task F1: Rename the directory

**Files:**
- Rename: `packages/server/` -> `packages/conductor/`

- [ ] **Step 1: Move the directory**

```bash
git mv packages/server packages/conductor
```

- [ ] **Step 2: Update package.json (if it has a name field that matters)**

In `packages/conductor/package.json`, update `name` to `@ark/conductor` (or whatever convention the rest of the workspace uses).

- [ ] **Step 3: Find and update all imports**

Run: `grep -rln "from \"\.\./\.\./server/" packages/ --include="*.ts"`

For each match, update the import path: `../../server/` -> `../../conductor/`.

Same for `from "../server/"` patterns:

```bash
grep -rln "from \"\.\./server/" packages/ --include="*.ts"
```

Use a sed pass:

```bash
find packages/ -name "*.ts" -exec sed -i '' 's|from "../../server/|from "../../conductor/|g' {} +
find packages/ -name "*.ts" -exec sed -i '' 's|from "../server/|from "../conductor/|g' {} +
find packages/ -name "*.ts" -exec sed -i '' 's|from "@ark/server"|from "@ark/conductor"|g' {} +
```

(Check that no `packages/server/` refs remain in any path strings outside imports.)

- [ ] **Step 4: Type-check**

Run: `bun x tsc --noEmit`
Expected: clean.

- [ ] **Step 5: Update Makefile + Dockerfile + helm**

Run: `grep -rn "packages/server\|@ark/server" Makefile .infra/ docs/`
Update each match.

- [ ] **Step 6: Run tests**

Run: `make test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor: rename packages/server to packages/conductor"
```

---

## Phase G: CLI consolidation + final cleanup

### Task G1: Consolidate `ark daemon` into `ark conductor`

**Files:**
- Delete: `packages/cli/commands/daemon.ts`
- Modify: `packages/cli/commands/conductor.ts` (absorb any unique behavior)
- Modify: `packages/cli/index.ts` (or wherever commands are registered)

- [ ] **Step 1: Compare daemon.ts and conductor.ts**

Read both files. Note any unique behavior in `daemon.ts` that needs to merge into `conductor.ts`.

- [ ] **Step 2: Move unique behavior**

If `daemon.ts` has subcommands (`start`, `stop`, `status`) that `conductor.ts` lacks, port them into `conductor.ts` so `ark conductor start`, `ark conductor stop`, `ark conductor status` all work.

- [ ] **Step 3: Delete daemon.ts**

```bash
rm packages/cli/commands/daemon.ts
```

- [ ] **Step 4: Remove daemon command registration**

In `packages/cli/index.ts`, remove the `program.command("daemon")...` block.

- [ ] **Step 5: Update help text + docs**

Search docs for `ark daemon` and replace with `ark conductor`:

```bash
grep -rln "ark daemon" docs/ CLAUDE.md
```

For each match, update.

- [ ] **Step 6: Run CLI tests**

Run: `make test-file F=packages/cli/__tests__/daemon.test.ts`

This test will need to rename to `conductor.test.ts` and update its expectations:

```bash
git mv packages/cli/__tests__/daemon.test.ts packages/cli/__tests__/conductor-cli.test.ts
```

Update the test contents to invoke `ark conductor` instead of `ark daemon`.

- [ ] **Step 7: Run + commit**

```bash
make test
git add -A
git commit -m "refactor(cli): consolidate ark daemon into ark conductor"
```

### Task G2: Final grep sweep for stragglers

**Files:** all

- [ ] **Step 1: Check for hardcoded 19100**

Run: `grep -rn "19100" packages/ docs/ CLAUDE.md`
Expected: no matches in code. Stale doc references can stay if explicitly historical, but flag and verify.

- [ ] **Step 2: Check for stale env / config names**

```bash
grep -rn "ARK_SERVER_PORT\|ports.server\|DEFAULT_SERVER_PORT" packages/ docs/ CLAUDE.md
```

Expected: no matches.

- [ ] **Step 3: Check for stale package paths**

```bash
grep -rn "packages/server\|@ark/server" packages/ docs/ Makefile .infra/
```

Expected: no matches (everything moved to packages/conductor).

- [ ] **Step 4: Check for stale class/function names that suggest two-port topology**

```bash
grep -rn "ConductorLauncher\|conductor-launcher\|startConductor.*ports.server" packages/
```

Expected: no matches.

- [ ] **Step 5: Commit any stragglers found**

If any matches turn up, fix them and:

```bash
git add -A
git commit -m "chore: clean up final stragglers from conductor merge"
```

### Task G3: End-to-end verification

- [ ] **Step 1: Full test suite**

Run: `make test`
Expected: all pass with `--concurrency 4`.

- [ ] **Step 2: Lint**

Run: `make lint`
Expected: zero warnings.

- [ ] **Step 3: Format**

Run: `make format`
Expected: no diffs.

- [ ] **Step 4: Boot the daemon end-to-end**

Run: `make dev-daemon`
Verify:
- Single `Bun.serve` listener on `:19400` (check `lsof -i :19400`).
- No listener on `:19100` (`lsof -i :19100` returns nothing).
- arkd boots and reports as healthy via `worker/heartbeat`.
- `/health` returns 200.
- `/v1/models` (OpenAI proxy) returns 200.

Stop with Ctrl-C.

- [ ] **Step 5: Boot the dashboard**

Run: `make dev`
Open: http://localhost:8420
Verify:
- Dashboard loads.
- Start a session via the UI.
- Session tree updates appear in real time (replacing the SSE we removed).

- [ ] **Step 6: Final commit if any debug changes leaked**

```bash
git status
# if clean, no commit needed
```

- [ ] **Step 7: Push branch**

```bash
git push -u origin conductor-server-merge
```

- [ ] **Step 8: Open PR**

Use `gh pr create` with a body that links the spec at `docs/superpowers/specs/2026-05-06-conductor-server-merge-design.md`.

---

## Self-review checklist

Run through this before declaring the plan complete.

**Spec coverage:**
- [x] Single port: Phase E4 builds the merged launcher; Phase G2 verifies no `:19100` listener.
- [x] Conductor REST -> JSON-RPC: Phase B adds every replacement handler.
- [x] SSE -> JSON-RPC subscription: Tasks B7 (handler), C3 (client), D2 (web caller).
- [x] arkd swap to ArkClient: Task D1.
- [x] `packages/core/conductor/` deletion: Task E1.
- [x] `ConductorLauncher` deletion: Task E2.
- [x] `handlers/conductor.ts` bridge deletion: Task E3.
- [x] Package rename: Phase F.
- [x] CLI daemon command consolidation: Task G1.
- [x] Config / env / constant rename: Phase A.
- [x] ArkdLauncher + compute adapter URL update: Tasks D3, D4.
- [x] Auth role gating: Task B11.
- [x] Subscription cleanup tests: Task B7 step 2 (cleanup test), B9, B10 (with onClose).

**Placeholder scan:** No "TBD" or "implement later" markers. A few "match the existing accessor by cross-referencing" prompts remain - these are reasonable because the existing accessor is the source of truth and changes file-by-file. Each task that asks for cross-reference points at the specific file to read.

**Type consistency:** Method names match across handler / ArkClient / test (`worker/register`, `worker/heartbeat`, `channel/deliver`, etc.). Types in `rpc-schemas.ts` mirror the handler param shapes.

**Risk callouts:**
- Phase B subscription handlers (B7, B9, B10) depend on `ctx.onClose` existing on the Router context. If it doesn't exist, the first task to need it (B7) adds it. Subsequent tasks reuse.
- Task D1 (arkd switch to ArkClient) is the highest-risk single task: it changes a long-running connection model from per-call HTTP to persistent WS. Test arkd reconnect explicitly and validate against EC2 dispatch if possible.
- Task F1 (package rename) is mechanical but high-blast-radius. Run a full `bun x tsc --noEmit` before commit.
