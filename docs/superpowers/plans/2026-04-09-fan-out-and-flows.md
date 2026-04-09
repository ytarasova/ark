# Fan-Out & Proper Flows Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix broken fan-out, add auto-join, support DAG flows, and enable Firecracker micro-VM isolation for parallel child sessions.

**Architecture:** Fix the spawn wiring bug so `parent_id` is set correctly. Add auto-join in the conductor so parents advance when all children complete. Upgrade the flow engine from linear stage-index advancement to DAG-based dependency resolution with `depends_on` fields. Fan-out children default to Firecracker micro-VMs on EC2 compute for hardware isolation.

**Tech Stack:** TypeScript, Bun, bun:test, SQLite, Firecracker micro-VMs

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `packages/cli/index.ts` | Modify | Fix `spawn` to call correct RPC |
| `packages/core/flow.ts` | Modify | Add `depends_on` to StageDefinition, add `fan_out` type, DAG resolution |
| `packages/core/services/session-orchestration.ts` | Modify | Wire `fanOut()`, add auto-join, add merge logic |
| `packages/core/conductor.ts` | Modify | Auto-join trigger on child completion |
| `packages/server/handlers/session.ts` | Modify | Add `session/fan-out` RPC handler |
| `packages/protocol/client.ts` | Modify | Add `sessionFanOut()` method |
| `flows/definitions/fan-out.yaml` | Modify | Fix stage type from `fan_out` to valid type |
| `packages/core/__tests__/fan-out-e2e.test.ts` | Create | E2E tests for spawn/join/auto-join |
| `packages/core/__tests__/dag-flow.test.ts` | Create | DAG flow resolution tests |
| `packages/core/worktree-merge.ts` | Create | Branch merge logic for join |

---

### Task 1: Fix `spawn` CLI Wiring

**Files:**
- Modify: `packages/cli/index.ts:473-485`

- [ ] **Step 1: Write failing test**

```ts
// packages/cli/__tests__/spawn-wiring.test.ts
import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";

describe("spawn command wiring", () => {
  test("spawn calls sessionSpawn not sessionFork", () => {
    const src = readFileSync("packages/cli/index.ts", "utf-8");
    // Find the spawn command handler
    const spawnMatch = src.match(/\.command\("spawn"\)[\s\S]*?\.action\(async.*?\{([\s\S]*?)\}\);/);
    expect(spawnMatch).toBeTruthy();
    const handler = spawnMatch![1];
    // Must call sessionSpawn, not sessionFork
    expect(handler).toContain("sessionSpawn");
    expect(handler).not.toContain("sessionFork");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `make test-file F=packages/cli/__tests__/spawn-wiring.test.ts`
Expected: FAIL -- handler currently calls `sessionFork`

- [ ] **Step 3: Fix the spawn command handler**

In `packages/cli/index.ts`, change the `spawn` command handler (~line 473-485):

```ts
session.command("spawn")
  .description("Spawn a child session for parallel work")
  .argument("<parent-id>")
  .argument("<task>")
  .option("-a, --agent <agent>", "Agent override")
  .option("-m, --model <model>", "Model override")
  .option("-d, --dispatch", "Auto-dispatch after spawning")
  .action(async (parentId, task, opts) => {
    const ark = await getArkClient();
    try {
      const r = await ark.sessionSpawn(parentId, {
        task,
        agent: opts.agent,
        model: opts.model,
      });
      if (!r.ok) { console.log(chalk.red(r.message)); return; }
      console.log(chalk.green(`Spawned -> ${r.sessionId}`));
      if (opts.dispatch && r.sessionId) {
        await ark.sessionDispatch(r.sessionId);
        console.log(chalk.green(`Dispatched ${r.sessionId}`));
      }
    } catch (e: any) {
      console.log(chalk.red(e.message));
    }
  });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `make test-file F=packages/cli/__tests__/spawn-wiring.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/cli/index.ts packages/cli/__tests__/spawn-wiring.test.ts
git commit -m "fix: spawn command calls sessionSpawn instead of sessionFork"
```

---

### Task 2: Fix `fan-out.yaml` Stage Type

**Files:**
- Modify: `packages/core/flow.ts:17-33`
- Modify: `flows/definitions/fan-out.yaml`

- [ ] **Step 1: Write failing test**

```ts
// packages/core/__tests__/flow-types.test.ts
import { describe, test, expect } from "bun:test";
import { getStageAction } from "../flow.js";

describe("flow stage types", () => {
  test("fan-out flow execute stage has recognized type", () => {
    const action = getStageAction("fan-out", "execute");
    expect(action.type).not.toBe("unknown");
    expect(["fork", "fan_out"]).toContain(action.type);
  });

  test("parallel flow implement stage is fork type", () => {
    const action = getStageAction("parallel", "implement");
    expect(action.type).toBe("fork");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `make test-file F=packages/core/__tests__/flow-types.test.ts`
Expected: FAIL -- `fan_out` is not in the StageDefinition type union

- [ ] **Step 3: Add `fan_out` to StageDefinition type union**

In `packages/core/flow.ts`, update the StageDefinition interface (~line 19):

```ts
export interface StageDefinition {
  name: string;
  type?: "agent" | "action" | "fork" | "fan_out";
  // ... rest unchanged
  depends_on?: string[];  // DAG: stages that must complete before this one
}
```

Update `getStageAction()` (~line 162) to handle `fan_out`:

```ts
export function getStageAction(flowName: string, stageName: string): StageAction {
  const stage = getStage(flowName, stageName);
  if (!stage) return { type: "unknown" };

  if (stage.type === "fork" || stage.type === "fan_out") {
    return {
      type: stage.type, agent: stage.agent ?? "implementer",
      strategy: stage.strategy ?? "plan", max_parallel: stage.max_parallel ?? 4,
      on_failure: stage.on_failure, optional: stage.optional,
    };
  }
  // ... rest unchanged
}
```

Update the `StageAction` type to include `fan_out`:

```ts
export interface StageAction {
  type: "agent" | "action" | "fork" | "fan_out" | "unknown";
  // ... rest unchanged
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `make test-file F=packages/core/__tests__/flow-types.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/flow.ts flows/definitions/fan-out.yaml packages/core/__tests__/flow-types.test.ts
git commit -m "fix: add fan_out stage type to flow engine"
```

---

### Task 3: Wire `fanOut()` as RPC Handler

**Files:**
- Modify: `packages/server/handlers/session.ts`
- Modify: `packages/protocol/client.ts`
- Modify: `packages/core/services/session.ts`

- [ ] **Step 1: Write failing test**

```ts
// packages/server/__tests__/fan-out-handler.test.ts
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { AppContext, setApp, clearApp } from "../../core/app.js";

let app: AppContext;
beforeAll(async () => { app = AppContext.forTest(); await app.boot(); setApp(app); });
afterAll(async () => { await app?.shutdown(); clearApp(); });

describe("session/fan-out handler", () => {
  test("creates child sessions with parent_id set", () => {
    const parent = app.sessions.create({ summary: "Parent task", flow: "bare" });
    app.sessions.update(parent.id, { status: "running", stage: "implement" });

    const { fanOut } = require("../../core/services/session-orchestration.js");
    const result = fanOut(parent.id, {
      tasks: [
        { summary: "Child A" },
        { summary: "Child B" },
      ],
    });

    expect(result.ok).toBe(true);
    expect(result.childIds).toHaveLength(2);

    for (const childId of result.childIds!) {
      const child = app.sessions.get(childId);
      expect(child).toBeTruthy();
      expect(child!.parent_id).toBe(parent.id);
    }

    const updated = app.sessions.get(parent.id);
    expect(updated!.status).toBe("waiting");
  });
});
```

- [ ] **Step 2: Run test to verify it passes** (fanOut already exists, just unwired)

Run: `make test-file F=packages/server/__tests__/fan-out-handler.test.ts`
Expected: PASS (the function exists, just not exposed as RPC)

- [ ] **Step 3: Add `fan-out` method to SessionService**

In `packages/core/services/session.ts`, add delegation method. Find the existing `spawn()` method and add after it:

```ts
async fanOut(sessionId: string, opts: { tasks: Array<{ summary: string; agent?: string; flow?: string }> }) {
  return fanOut(sessionId, opts);
}
```

Import `fanOut` from `session-orchestration.js` at the top of the file.

- [ ] **Step 4: Add RPC handler in server**

In `packages/server/handlers/session.ts`, add after the `session/spawn` handler (~line 212):

```ts
router.handle("session/fan-out", async (params, notify) => {
  const { sessionId, tasks } = extract<{ sessionId: string; tasks: Array<{ summary: string; agent?: string; flow?: string }> }>(params, ["sessionId", "tasks"]);
  const result = await app.sessionService.fanOut(sessionId, { tasks });
  if (!result.ok) throw new RpcError(result.message ?? "Fan-out failed", SESSION_NOT_FOUND);
  for (const childId of result.childIds ?? []) {
    const session = app.sessions.get(childId);
    if (session) notify("session/created", { session });
  }
  return result;
});
```

- [ ] **Step 5: Add `sessionFanOut()` to protocol client**

In `packages/protocol/client.ts`, add after `sessionSpawn()` (~line 468):

```ts
async sessionFanOut(sessionId: string, tasks: Array<{ summary: string; agent?: string; flow?: string }>): Promise<{ ok: boolean; childIds?: string[]; message?: string }> {
  return this.rpc<{ ok: boolean; childIds?: string[]; message?: string }>("session/fan-out", { sessionId, tasks });
}
```

- [ ] **Step 6: Add CLI command**

In `packages/cli/index.ts`, add after the `spawn-subagent` command:

```ts
session.command("fan-out")
  .description("Fan out into parallel child sessions")
  .argument("<parent-id>")
  .argument("<tasks...>", "Task summaries for each child")
  .option("-a, --agent <agent>", "Agent for all children")
  .option("-d, --dispatch", "Auto-dispatch all children")
  .action(async (parentId, tasks, opts) => {
    const ark = await getArkClient();
    try {
      const r = await ark.sessionFanOut(parentId, tasks.map((t: string) => ({
        summary: t,
        agent: opts.agent,
      })));
      if (!r.ok) { console.log(chalk.red(r.message)); return; }
      for (const id of r.childIds ?? []) {
        console.log(chalk.green(`  Child -> ${id}`));
        if (opts.dispatch) {
          await ark.sessionDispatch(id);
          console.log(chalk.green(`  Dispatched ${id}`));
        }
      }
    } catch (e: any) {
      console.log(chalk.red(e.message));
    }
  });
```

- [ ] **Step 7: Run tests**

Run: `make test-file F=packages/server/__tests__/fan-out-handler.test.ts`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add packages/server/handlers/session.ts packages/protocol/client.ts packages/core/services/session.ts packages/cli/index.ts packages/server/__tests__/fan-out-handler.test.ts
git commit -m "feat: wire fanOut() as session/fan-out RPC handler + CLI command"
```

---

### Task 4: Handle `fan_out` Stage Type in Dispatch

**Files:**
- Modify: `packages/core/services/session-orchestration.ts`

- [ ] **Step 1: Write failing test**

```ts
// packages/core/__tests__/dispatch-fan-out.test.ts
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { AppContext, setApp, clearApp } from "../app.js";
import { dispatch } from "../services/session-orchestration.js";

let app: AppContext;
beforeAll(async () => { app = AppContext.forTest(); await app.boot(); setApp(app); });
afterAll(async () => { await app?.shutdown(); clearApp(); });

describe("dispatch fan_out stage", () => {
  test("fan_out stage creates children and sets parent to waiting", () => {
    const parent = app.sessions.create({ summary: "Test fan-out", flow: "fan-out" });
    app.sessions.update(parent.id, { stage: "execute", status: "ready" });

    const result = dispatch(parent.id);
    expect(result.ok).toBe(true);

    const updated = app.sessions.get(parent.id);
    expect(updated!.status).toBe("waiting");

    const children = app.sessions.getChildren(parent.id);
    expect(children.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `make test-file F=packages/core/__tests__/dispatch-fan-out.test.ts`
Expected: FAIL -- dispatch doesn't handle `fan_out` type

- [ ] **Step 3: Add `fan_out` handling to dispatch**

In `packages/core/services/session-orchestration.ts`, find the dispatch function. Locate the `if (stageDef?.type === "fork")` check (~line 199). Add `fan_out` handling:

```ts
if (stageDef?.type === "fork") {
  return dispatchFork(sessionId, stageDef);
}

if (stageDef?.type === "fan_out") {
  return dispatchFanOut(sessionId, stageDef);
}
```

Add the `dispatchFanOut` function:

```ts
function dispatchFanOut(sessionId: string, stageDef: flow.StageDefinition): { ok: boolean; message: string } {
  const session = getApp().sessions.get(sessionId)!;
  const subtasks = extractSubtasks(session);

  const maxParallel = stageDef.max_parallel ?? 8;
  const result = fanOut(sessionId, {
    tasks: subtasks.slice(0, maxParallel).map((s) => ({
      summary: s.task,
      agent: stageDef.agent ?? session.agent ?? "implementer",
    })),
  });

  if (!result.ok) return { ok: false, message: result.message ?? "Fan-out failed" };

  // Auto-dispatch all children
  for (const childId of result.childIds ?? []) {
    dispatch(childId);
  }

  return { ok: true, message: `Fan-out: ${result.childIds?.length ?? 0} children dispatched` };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `make test-file F=packages/core/__tests__/dispatch-fan-out.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/services/session-orchestration.ts packages/core/__tests__/dispatch-fan-out.test.ts
git commit -m "feat: dispatch handles fan_out stage type"
```

---

### Task 5: Auto-Join on Child Completion

**Files:**
- Modify: `packages/core/conductor.ts`
- Modify: `packages/core/services/session-orchestration.ts`
- Create: `packages/core/worktree-merge.ts`

- [ ] **Step 1: Write failing test**

```ts
// packages/core/__tests__/auto-join.test.ts
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { AppContext, setApp, clearApp } from "../app.js";
import { fanOut, checkAutoJoin } from "../services/session-orchestration.js";

let app: AppContext;
beforeAll(async () => { app = AppContext.forTest(); await app.boot(); setApp(app); });
afterAll(async () => { await app?.shutdown(); clearApp(); });

describe("auto-join", () => {
  test("parent advances when all children complete", async () => {
    const parent = app.sessions.create({ summary: "Parent", flow: "fan-out" });
    app.sessions.update(parent.id, { stage: "execute", status: "running" });

    const result = fanOut(parent.id, {
      tasks: [{ summary: "A" }, { summary: "B" }],
    });
    expect(result.ok).toBe(true);

    // Complete both children
    for (const childId of result.childIds!) {
      app.sessions.update(childId, { status: "completed" });
    }

    // Trigger auto-join check
    const joinResult = await checkAutoJoin(result.childIds![0]);
    expect(joinResult).toBe(true);

    // Parent should have advanced past the execute stage
    const updated = app.sessions.get(parent.id);
    expect(updated!.status).not.toBe("waiting");
  });

  test("parent stays waiting when some children not done", async () => {
    const parent = app.sessions.create({ summary: "Parent2", flow: "fan-out" });
    app.sessions.update(parent.id, { stage: "execute", status: "running" });

    const result = fanOut(parent.id, {
      tasks: [{ summary: "C" }, { summary: "D" }],
    });

    // Complete only one child
    app.sessions.update(result.childIds![0], { status: "completed" });

    const joinResult = await checkAutoJoin(result.childIds![0]);
    expect(joinResult).toBe(false);

    const updated = app.sessions.get(parent.id);
    expect(updated!.status).toBe("waiting");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `make test-file F=packages/core/__tests__/auto-join.test.ts`
Expected: FAIL -- `checkAutoJoin` doesn't exist

- [ ] **Step 3: Implement `checkAutoJoin`**

In `packages/core/services/session-orchestration.ts`, add:

```ts
export async function checkAutoJoin(childSessionId: string): Promise<boolean> {
  const child = getApp().sessions.get(childSessionId);
  if (!child?.parent_id) return false;

  const parent = getApp().sessions.get(child.parent_id);
  if (!parent) return false;
  if (parent.status !== "waiting") return false;

  const children = getApp().sessions.getChildren(parent.id);
  const allDone = children.every((c) => c.status === "completed" || c.status === "failed");
  if (!allDone) return false;

  const failed = children.filter((c) => c.status === "failed");
  if (failed.length > 0) {
    getApp().events.log(parent.id, "fan_out_partial_failure", {
      actor: "system",
      data: { failed: failed.map((f) => f.id), total: children.length },
    });
  }

  // Merge child worktree branches into parent
  await mergeChildBranches(parent.id, children);

  // Join and advance
  getApp().events.log(parent.id, "auto_join", {
    actor: "system",
    data: { children: children.length, failed: failed.length },
  });
  getApp().sessions.update(parent.id, { status: "ready", fork_group: null });
  await advance(parent.id, true);
  return true;
}
```

- [ ] **Step 4: Create `worktree-merge.ts`**

```ts
// packages/core/worktree-merge.ts
import { execFileSync } from "child_process";
import { existsSync } from "fs";
import { getApp } from "./app.js";
import type { Session } from "../types/index.js";

export async function mergeChildBranches(
  parentId: string,
  children: Session[],
): Promise<{ merged: string[]; conflicts: string[] }> {
  const parent = getApp().sessions.get(parentId);
  if (!parent?.workdir) return { merged: [], conflicts: [] };

  const parentWorktree = `${process.env.HOME}/.ark/worktrees/${parentId}`;
  if (!existsSync(parentWorktree)) return { merged: [], conflicts: [] };

  const merged: string[] = [];
  const conflicts: string[] = [];

  for (const child of children) {
    if (child.status === "failed") continue;

    const childWorktree = `${process.env.HOME}/.ark/worktrees/${child.id}`;
    if (!existsSync(childWorktree)) continue;

    try {
      // Get child's branch name
      const branch = execFileSync(
        "git", ["-C", childWorktree, "rev-parse", "--abbrev-ref", "HEAD"],
        { encoding: "utf-8" },
      ).trim();
      if (!branch || branch === "HEAD") continue;

      // Attempt merge into parent's worktree
      execFileSync(
        "git", ["-C", parentWorktree, "merge", "--no-edit", branch],
        { encoding: "utf-8", stdio: "pipe" },
      );
      merged.push(child.id);
    } catch (e: any) {
      const msg = (e.message ?? "") + (e.stderr ?? "");
      if (msg.includes("CONFLICT")) {
        // Abort the failed merge
        try {
          execFileSync("git", ["-C", parentWorktree, "merge", "--abort"], { stdio: "pipe" });
        } catch {}
        conflicts.push(child.id);
      }
    }
  }

  if (conflicts.length > 0) {
    getApp().events.log(parentId, "merge_conflict", {
      actor: "system",
      data: { merged, conflicts },
    });
    getApp().sessions.update(parentId, { status: "waiting" });
  }

  return { merged, conflicts };
}
```

- [ ] **Step 5: Hook auto-join into conductor**

In `packages/core/conductor.ts`, find the `handleReport` function (~line 397). After the `shouldAdvance` block that calls `session.advance()`, add:

```ts
// Check if this completion triggers auto-join for a parent
const currentSession = getApp().sessions.get(sessionId);
if (currentSession?.parent_id && (result.updates.status === "completed" || result.updates.status === "failed")) {
  void session.checkAutoJoin(sessionId);
}
```

Also in the hook status handler, after status updates are applied, add similar logic:

```ts
if (hResult.updates.status === "completed" || hResult.updates.status === "failed") {
  const sess = getApp().sessions.get(sessionId);
  if (sess?.parent_id) {
    void session.checkAutoJoin(sessionId);
  }
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `make test-file F=packages/core/__tests__/auto-join.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add packages/core/services/session-orchestration.ts packages/core/worktree-merge.ts packages/core/conductor.ts packages/core/__tests__/auto-join.test.ts
git commit -m "feat: auto-join parent when all children complete"
```

---

### Task 6: DAG Flow Engine -- `depends_on` Support

**Files:**
- Modify: `packages/core/flow.ts`
- Create: `packages/core/__tests__/dag-flow.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// packages/core/__tests__/dag-flow.test.ts
import { describe, test, expect } from "bun:test";
import { getReadyStages, validateDAG } from "../flow.js";
import type { StageDefinition } from "../flow.js";

describe("DAG flow resolution", () => {
  const stages: StageDefinition[] = [
    { name: "plan", agent: "planner", gate: "auto" },
    { name: "impl-api", agent: "implementer", gate: "auto", depends_on: ["plan"] },
    { name: "impl-ui", agent: "implementer", gate: "auto", depends_on: ["plan"] },
    { name: "integrate", agent: "implementer", gate: "auto", depends_on: ["impl-api", "impl-ui"] },
    { name: "review", agent: "reviewer", gate: "auto", depends_on: ["integrate"] },
  ];

  test("first stage has no dependencies", () => {
    const ready = getReadyStages(stages, []);
    expect(ready.map((s) => s.name)).toEqual(["plan"]);
  });

  test("parallel stages become ready when dependency completes", () => {
    const ready = getReadyStages(stages, ["plan"]);
    expect(ready.map((s) => s.name).sort()).toEqual(["impl-api", "impl-ui"]);
  });

  test("merge stage waits for all dependencies", () => {
    const ready = getReadyStages(stages, ["plan", "impl-api"]);
    expect(ready.map((s) => s.name)).toEqual([]);
  });

  test("merge stage ready when all deps done", () => {
    const ready = getReadyStages(stages, ["plan", "impl-api", "impl-ui"]);
    expect(ready.map((s) => s.name)).toEqual(["integrate"]);
  });

  test("validateDAG detects cycles", () => {
    const cyclic: StageDefinition[] = [
      { name: "a", agent: "x", gate: "auto", depends_on: ["b"] },
      { name: "b", agent: "x", gate: "auto", depends_on: ["a"] },
    ];
    expect(() => validateDAG(cyclic)).toThrow("cycle");
  });

  test("linear stages without depends_on default to sequential", () => {
    const linear: StageDefinition[] = [
      { name: "plan", agent: "planner", gate: "auto" },
      { name: "implement", agent: "implementer", gate: "auto" },
      { name: "review", agent: "reviewer", gate: "auto" },
    ];
    const ready0 = getReadyStages(linear, []);
    expect(ready0.map((s) => s.name)).toEqual(["plan"]);

    const ready1 = getReadyStages(linear, ["plan"]);
    expect(ready1.map((s) => s.name)).toEqual(["implement"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `make test-file F=packages/core/__tests__/dag-flow.test.ts`
Expected: FAIL -- `getReadyStages`, `validateDAG` don't exist

- [ ] **Step 3: Implement DAG resolution functions**

In `packages/core/flow.ts`, add at the bottom of the file:

```ts
/**
 * Given a list of stages and which stages are completed,
 * return the stages that are ready to execute (all dependencies met).
 * Stages without depends_on default to depending on the previous stage (linear).
 */
export function getReadyStages(
  stages: StageDefinition[],
  completedStages: string[],
): StageDefinition[] {
  const completed = new Set(completedStages);
  const ready: StageDefinition[] = [];

  for (let i = 0; i < stages.length; i++) {
    const stage = stages[i];
    if (completed.has(stage.name)) continue;

    // If depends_on is explicit, use it
    let deps = stage.depends_on;

    // If no depends_on, default to linear: depend on previous stage
    if (!deps && i > 0) {
      deps = [stages[i - 1].name];
    }

    // No deps (first stage) or all deps met
    if (!deps || deps.length === 0 || deps.every((d) => completed.has(d))) {
      ready.push(stage);
    }
  }

  return ready;
}

/**
 * Validate that stage dependencies form a DAG (no cycles).
 * Throws if a cycle is detected.
 */
export function validateDAG(stages: StageDefinition[]): void {
  const graph = new Map<string, string[]>();
  for (let i = 0; i < stages.length; i++) {
    const deps = stages[i].depends_on ?? (i > 0 ? [stages[i - 1].name] : []);
    graph.set(stages[i].name, deps);
  }

  const visited = new Set<string>();
  const visiting = new Set<string>();

  function visit(node: string): void {
    if (visiting.has(node)) throw new Error(`Flow has a cycle involving stage "${node}"`);
    if (visited.has(node)) return;
    visiting.add(node);
    for (const dep of graph.get(node) ?? []) {
      visit(dep);
    }
    visiting.delete(node);
    visited.add(node);
  }

  for (const stage of stages) {
    visit(stage.name);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `make test-file F=packages/core/__tests__/dag-flow.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/flow.ts packages/core/__tests__/dag-flow.test.ts
git commit -m "feat: DAG flow engine with depends_on, getReadyStages, validateDAG"
```

---

### Task 7: Integrate DAG Advancement into Session Orchestration

**Files:**
- Modify: `packages/core/services/session-orchestration.ts`

- [ ] **Step 1: Write test**

```ts
// packages/core/__tests__/dag-advance.test.ts
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { AppContext, setApp, clearApp } from "../app.js";
import { advance } from "../services/session-orchestration.js";

let app: AppContext;
beforeAll(async () => { app = AppContext.forTest(); await app.boot(); setApp(app); });
afterAll(async () => { await app?.shutdown(); clearApp(); });

describe("DAG-based advance", () => {
  test("advance moves to next linear stage", async () => {
    const s = app.sessions.create({ summary: "Test linear", flow: "bare" });
    app.sessions.update(s.id, { stage: "implement", status: "ready" });

    const result = await advance(s.id);
    // bare flow has only implement stage, so completing it should end the flow
    const updated = app.sessions.get(s.id);
    expect(updated!.status).toBe("completed");
  });
});
```

- [ ] **Step 2: Run test**

Run: `make test-file F=packages/core/__tests__/dag-advance.test.ts`

- [ ] **Step 3: Update `advance()` to use DAG resolution for flows with `depends_on`**

In `packages/core/services/session-orchestration.ts`, find the `advance()` function. Add a helper to track completed stages via events, and use `getReadyStages()` when a flow uses `depends_on`:

```ts
function getCompletedStages(session: Session): string[] {
  const events = getApp().events.list(session.id);
  const completed: string[] = [];
  for (const evt of events) {
    if (evt.type === "stage_advance" && evt.data?.from) {
      completed.push(evt.data.from as string);
    }
  }
  // Current stage is completing too
  if (session.stage) completed.push(session.stage);
  return [...new Set(completed)];
}
```

Update the advance function to check if the flow has any `depends_on` fields. If so, use DAG resolution. Otherwise, keep existing linear advancement. This preserves backward compatibility.

- [ ] **Step 4: Run tests**

Run: `make test-file F=packages/core/__tests__/dag-advance.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/services/session-orchestration.ts packages/core/__tests__/dag-advance.test.ts
git commit -m "feat: DAG-based stage advancement with parallel fan-out"
```

---

### Task 8: Firecracker Compute Inheritance for Fan-Out Children

**Files:**
- Create: `packages/core/__tests__/fan-out-compute.test.ts`

- [ ] **Step 1: Write test**

```ts
// packages/core/__tests__/fan-out-compute.test.ts
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { AppContext, setApp, clearApp } from "../app.js";
import { fanOut } from "../services/session-orchestration.js";

let app: AppContext;
beforeAll(async () => { app = AppContext.forTest(); await app.boot(); setApp(app); });
afterAll(async () => { await app?.shutdown(); clearApp(); });

describe("fan-out compute inheritance", () => {
  test("children inherit parent compute_name", () => {
    const parent = app.sessions.create({ summary: "Parent on EC2", flow: "bare" });
    app.sessions.update(parent.id, { status: "running", stage: "implement", compute_name: "my-ec2" });

    const result = fanOut(parent.id, {
      tasks: [{ summary: "Child A" }, { summary: "Child B" }],
    });

    expect(result.ok).toBe(true);
    for (const childId of result.childIds!) {
      const child = app.sessions.get(childId);
      expect(child!.compute_name).toBe("my-ec2");
    }
  });

  test("children inherit parent workdir and repo", () => {
    const parent = app.sessions.create({ summary: "Parent", flow: "bare" });
    app.sessions.update(parent.id, {
      status: "running", stage: "implement",
      compute_name: "fc-host", workdir: "/home/ubuntu/myrepo", repo: "myrepo",
    });

    const result = fanOut(parent.id, { tasks: [{ summary: "Child" }] });
    expect(result.ok).toBe(true);

    const child = app.sessions.get(result.childIds![0]);
    expect(child!.compute_name).toBe("fc-host");
    expect(child!.workdir).toBe("/home/ubuntu/myrepo");
    expect(child!.repo).toBe("myrepo");
  });
});
```

- [ ] **Step 2: Run test -- should pass since fanOut() already copies these fields**

Run: `make test-file F=packages/core/__tests__/fan-out-compute.test.ts`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add packages/core/__tests__/fan-out-compute.test.ts
git commit -m "test: verify fan-out children inherit compute for Firecracker isolation"
```

---

### Task 9: Create DAG Flow Definitions

**Files:**
- Create: `flows/definitions/dag-parallel.yaml`

- [ ] **Step 1: Create dag-parallel flow**

```yaml
# flows/definitions/dag-parallel.yaml
name: dag-parallel
description: "Plan, then parallel implement + test, integrate, review, PR"
stages:
  - name: plan
    agent: planner
    gate: manual
    task: |
      Analyze {summary} and create PLAN.md.
      Decompose into independent implementation tasks.

  - name: implement
    agent: implementer
    gate: auto
    depends_on: [plan]
    task: |
      Implement the code changes from PLAN.md for: {summary}

  - name: test
    agent: implementer
    gate: auto
    depends_on: [plan]
    task: |
      Write tests for: {summary}
      Focus on unit and integration tests.

  - name: integrate
    agent: implementer
    gate: auto
    depends_on: [implement, test]
    task: |
      Merge implementation and test branches.
      Run all tests. Fix any integration issues.

  - name: review
    agent: reviewer
    gate: manual
    depends_on: [integrate]

  - name: pr
    action: create_pr
    gate: auto
    depends_on: [review]
```

- [ ] **Step 2: Write test that flow loads correctly**

```ts
// packages/core/__tests__/dag-flow-load.test.ts
import { describe, test, expect } from "bun:test";
import { getStages, getStage, validateDAG } from "../flow.js";

describe("dag-parallel flow", () => {
  test("loads with correct stages", () => {
    const stages = getStages("dag-parallel");
    expect(stages).toHaveLength(6);
    expect(stages.map((s) => s.name)).toEqual(["plan", "implement", "test", "integrate", "review", "pr"]);
  });

  test("implement and test depend on plan", () => {
    const impl = getStage("dag-parallel", "implement");
    const testStage = getStage("dag-parallel", "test");
    expect(impl?.depends_on).toEqual(["plan"]);
    expect(testStage?.depends_on).toEqual(["plan"]);
  });

  test("integrate depends on both implement and test", () => {
    const integrate = getStage("dag-parallel", "integrate");
    expect(integrate?.depends_on).toEqual(["implement", "test"]);
  });

  test("DAG is valid (no cycles)", () => {
    const stages = getStages("dag-parallel");
    expect(() => validateDAG(stages)).not.toThrow();
  });
});
```

- [ ] **Step 3: Run test**

Run: `make test-file F=packages/core/__tests__/dag-flow-load.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add flows/definitions/dag-parallel.yaml packages/core/__tests__/dag-flow-load.test.ts
git commit -m "feat: add dag-parallel flow with depends_on for parallel stages"
```

---

### Task 10: E2E Integration Test

**Files:**
- Create: `packages/core/__tests__/fan-out-e2e.test.ts`

- [ ] **Step 1: Write E2E test covering full lifecycle**

```ts
// packages/core/__tests__/fan-out-e2e.test.ts
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { AppContext, setApp, clearApp } from "../app.js";
import { fanOut, checkAutoJoin, spawnSubagent } from "../services/session-orchestration.js";
import { getReadyStages, getStages, validateDAG } from "../flow.js";

let app: AppContext;
beforeAll(async () => { app = AppContext.forTest(); await app.boot(); setApp(app); });
afterAll(async () => { await app?.shutdown(); clearApp(); });

describe("fan-out E2E", () => {
  test("full lifecycle: create parent, fan-out, complete children, auto-join", async () => {
    // 1. Create parent
    const parent = app.sessions.create({ summary: "E2E fan-out test", flow: "bare" });
    app.sessions.update(parent.id, { stage: "implement", status: "running" });

    // 2. Fan out into 3 children
    const result = fanOut(parent.id, {
      tasks: [{ summary: "Task A" }, { summary: "Task B" }, { summary: "Task C" }],
    });
    expect(result.ok).toBe(true);
    expect(result.childIds).toHaveLength(3);

    // 3. Verify parent is waiting
    let parentState = app.sessions.get(parent.id);
    expect(parentState!.status).toBe("waiting");

    // 4. Verify children have parent_id
    for (const childId of result.childIds!) {
      const child = app.sessions.get(childId);
      expect(child!.parent_id).toBe(parent.id);
      expect(child!.fork_group).toBeTruthy();
    }

    // 5. Complete children one by one -- auto-join only fires when ALL done
    app.sessions.update(result.childIds![0], { status: "completed" });
    let joined = await checkAutoJoin(result.childIds![0]);
    expect(joined).toBe(false);

    app.sessions.update(result.childIds![1], { status: "completed" });
    joined = await checkAutoJoin(result.childIds![1]);
    expect(joined).toBe(false);

    app.sessions.update(result.childIds![2], { status: "completed" });
    joined = await checkAutoJoin(result.childIds![2]);
    expect(joined).toBe(true);

    // 6. Verify parent advanced
    parentState = app.sessions.get(parent.id);
    expect(parentState!.status).not.toBe("waiting");
  });

  test("spawn creates child with correct parent linkage", () => {
    const parent = app.sessions.create({ summary: "Spawn test", flow: "bare" });
    app.sessions.update(parent.id, { stage: "implement", status: "running" });

    const result = spawnSubagent(parent.id, { task: "Child task" });
    expect(result.ok).toBe(true);

    const child = app.sessions.get(result.sessionId!);
    expect(child!.parent_id).toBe(parent.id);
  });

  test("DAG flow validation works", () => {
    const stages = getStages("dag-parallel");
    expect(() => validateDAG(stages)).not.toThrow();
  });

  test("DAG flow ready stages resolve correctly", () => {
    const stages = getStages("dag-parallel");

    // Initially only plan is ready
    const ready0 = getReadyStages(stages, []);
    expect(ready0.map((s) => s.name)).toEqual(["plan"]);

    // After plan, implement + test are parallel-ready
    const ready1 = getReadyStages(stages, ["plan"]);
    expect(ready1.map((s) => s.name).sort()).toEqual(["implement", "test"]);

    // After implement only, integrate not ready (needs test too)
    const ready2 = getReadyStages(stages, ["plan", "implement"]);
    expect(ready2.map((s) => s.name)).toEqual([]);

    // After both, integrate is ready
    const ready3 = getReadyStages(stages, ["plan", "implement", "test"]);
    expect(ready3.map((s) => s.name)).toEqual(["integrate"]);
  });
});
```

- [ ] **Step 2: Run E2E test**

Run: `make test-file F=packages/core/__tests__/fan-out-e2e.test.ts`
Expected: PASS

- [ ] **Step 3: Run full test suite to verify no regressions**

Run: `make test`
Expected: All tests pass

- [ ] **Step 4: Commit**

```bash
git add packages/core/__tests__/fan-out-e2e.test.ts
git commit -m "test: E2E fan-out lifecycle + DAG flow resolution"
```

---

## Summary

| Task | What | Tests |
|------|------|-------|
| 1 | Fix `spawn` wiring (calls correct RPC) | 1 test |
| 2 | Add `fan_out` stage type to flow engine | 2 tests |
| 3 | Wire `fanOut()` as RPC + CLI command | 1 test |
| 4 | Handle `fan_out` in dispatch | 1 test |
| 5 | Auto-join on child completion + branch merge | 2 tests |
| 6 | DAG flow engine (`depends_on`, `getReadyStages`, `validateDAG`) | 6 tests |
| 7 | DAG-based `advance()` with parallel fan-out | 1 test |
| 8 | Firecracker compute inheritance for children | 2 tests |
| 9 | DAG flow definitions (`dag-parallel.yaml`) | 4 tests |
| 10 | E2E integration test | 4 tests |

**Total: 10 tasks, ~24 new tests**
