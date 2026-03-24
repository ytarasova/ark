# Test Coverage Improvement Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the 8 identified test coverage gaps across core logic and TUI hooks.

**Architecture:** Each task adds a test file matching existing conventions — `bun:test` imports, `createTestContext()` isolation for core tests, `ink-testing-library` for hooks. Flow and agent tests use temp YAML files instead of hitting real builtins. The `exec.ts` file uses `bun:ffi` and `posix_spawnp` — only testable via real process execution (integration-style), so we test it by spawning a known command.

**Tech Stack:** Vitest 2.0 + Bun runtime, ink-testing-library for React hooks

---

### Task 1: agent.ts — CRUD and template resolution

**Files:**
- Test: `packages/core/__tests__/agent.test.ts`

Tests `loadAgent`, `listAgents`, `saveAgent`, `deleteAgent`, `resolveAgent`, and `buildClaudeArgs`. Uses a temp user dir via `createTestContext` to write YAML files. Does NOT test builtins (filesystem-dependent) — tests user-dir CRUD and template variable substitution.

- [ ] **Step 1: Write the test file**

```ts
/**
 * Tests for agent.ts — CRUD, template resolution, CLI arg building.
 */

import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import YAML from "yaml";
import {
  createTestContext, setContext, resetContext,
  type TestContext,
} from "../context.js";
import {
  loadAgent, listAgents, saveAgent, deleteAgent,
  resolveAgent, buildClaudeArgs,
  type AgentDefinition,
} from "../agent.js";
import { ARK_DIR } from "../store.js";

let ctx: TestContext;
const agentDir = () => join(ARK_DIR, "agents");

function writeAgentYaml(name: string, data: Record<string, unknown>) {
  mkdirSync(agentDir(), { recursive: true });
  writeFileSync(join(agentDir(), `${name}.yaml`), YAML.stringify(data));
}

beforeEach(() => {
  if (ctx) ctx.cleanup();
  ctx = createTestContext();
  setContext(ctx);
  // Clean user agent dir to prevent leaking between tests
  rmSync(agentDir(), { recursive: true, force: true });
});

afterAll(() => {
  if (ctx) ctx.cleanup();
  resetContext();
});

// ── loadAgent ──────────────────────────────────────────────────────────────

describe("loadAgent", () => {
  it("returns null for non-existent agent", () => {
    expect(loadAgent("does-not-exist")).toBeNull();
  });

  it("loads a user agent from YAML", () => {
    writeAgentYaml("test-agent", { name: "test-agent", model: "opus", description: "A test" });
    const agent = loadAgent("test-agent");
    expect(agent).not.toBeNull();
    expect(agent!.name).toBe("test-agent");
    expect(agent!.model).toBe("opus");
    expect(agent!._source).toBe("user");
  });

  it("fills in defaults for missing fields", () => {
    writeAgentYaml("minimal", { name: "minimal" });
    const agent = loadAgent("minimal")!;
    expect(agent.model).toBe("sonnet");
    expect(agent.max_turns).toBe(200);
    expect(agent.tools).toEqual(["Bash", "Read", "Write", "Edit", "Glob", "Grep"]);
    expect(agent.mcp_servers).toEqual([]);
    expect(agent.env).toEqual({});
  });
});

// ── listAgents ─────────────────────────────────────────────────────────────

describe("listAgents", () => {
  it("returns empty when no user agents exist", () => {
    // May include builtins, but user agents dir doesn't exist yet
    const agents = listAgents();
    const userAgents = agents.filter(a => a._source === "user");
    expect(userAgents.length).toBe(0);
  });

  it("lists user agents from YAML directory", () => {
    writeAgentYaml("alpha", { name: "alpha" });
    writeAgentYaml("beta", { name: "beta" });
    const agents = listAgents();
    const userAgents = agents.filter(a => a._source === "user");
    expect(userAgents.length).toBe(2);
    expect(userAgents.map(a => a.name).sort()).toEqual(["alpha", "beta"]);
  });
});

// ── saveAgent / deleteAgent ────────────────────────────────────────────────

describe("saveAgent", () => {
  it("saves and reloads an agent", () => {
    const agent: AgentDefinition = {
      name: "saved-agent",
      description: "Saved via API",
      model: "haiku",
      max_turns: 50,
      system_prompt: "Be brief.",
      tools: ["Bash"],
      mcp_servers: [],
      skills: [],
      memories: [],
      context: [],
      permission_mode: "bypassPermissions",
      env: { FOO: "bar" },
    };
    saveAgent(agent);
    const loaded = loadAgent("saved-agent");
    expect(loaded).not.toBeNull();
    expect(loaded!.model).toBe("haiku");
    expect(loaded!.env.FOO).toBe("bar");
  });
});

describe("deleteAgent", () => {
  it("returns false for non-existent agent", () => {
    expect(deleteAgent("nope")).toBe(false);
  });

  it("deletes an existing user agent", () => {
    writeAgentYaml("doomed", { name: "doomed" });
    expect(deleteAgent("doomed")).toBe(true);
    // loadAgent may still return a builtin, so check it's not a user agent
    const after = loadAgent("doomed");
    expect(after === null || after._source !== "user").toBe(true);
  });
});

// ── resolveAgent ───────────────────────────────────────────────────────────

describe("resolveAgent", () => {
  it("returns null for unknown agent", () => {
    expect(resolveAgent("nope", {})).toBeNull();
  });

  it("substitutes template variables in system_prompt", () => {
    writeAgentYaml("templated", {
      name: "templated",
      system_prompt: "Working on {ticket}: {summary} in {repo}",
    });
    const agent = resolveAgent("templated", {
      ticket: "PROJ-123",
      summary: "Fix the bug",
      repo: "/home/user/project",
    });
    expect(agent!.system_prompt).toBe("Working on PROJ-123: Fix the bug in /home/user/project");
  });

  it("preserves unknown template vars", () => {
    writeAgentYaml("partial", {
      name: "partial",
      system_prompt: "Hello {unknown_var}",
    });
    const agent = resolveAgent("partial", {});
    expect(agent!.system_prompt).toBe("Hello {unknown_var}");
  });

  it("handles empty session fields gracefully", () => {
    writeAgentYaml("empty", {
      name: "empty",
      system_prompt: "ticket={ticket} branch={branch}",
    });
    const agent = resolveAgent("empty", {});
    expect(agent!.system_prompt).toBe("ticket= branch=");
  });
});

// ── buildClaudeArgs ────────────────────────────────────────────────────────

describe("buildClaudeArgs", () => {
  it("builds args from an agent definition", () => {
    writeAgentYaml("builder", { name: "builder", model: "opus", max_turns: 10 });
    const agent = loadAgent("builder")!;
    const args = buildClaudeArgs(agent);
    expect(args[0]).toBe("claude");
    expect(args).toContain("--model");
    expect(args).toContain("--max-turns");
  });

  it("passes headless and task options through", () => {
    writeAgentYaml("headless", { name: "headless" });
    const agent = loadAgent("headless")!;
    const args = buildClaudeArgs(agent, { headless: true, task: "do work" });
    expect(args).toContain("-p");
    expect(args).toContain("do work");
  });
});
```

- [ ] **Step 2: Run the test to verify failures**

Run: `cd /Users/yana/Projects/ark && npx vitest run packages/core/__tests__/agent.test.ts`

Expected: tests should fail because the functions are not yet imported or there are minor issues. Fix any import/path issues.

- [ ] **Step 3: Fix any issues, re-run until green**

- [ ] **Step 4: Commit**

```bash
git add packages/core/__tests__/agent.test.ts
git commit -m "test: add unit tests for agent CRUD and template resolution"
```

---

### Task 2: flow.ts — loading, navigation, gate evaluation

**Files:**
- Test: `packages/core/__tests__/flow.test.ts`

Tests `loadFlow`, `listFlows`, `getStages`, `getStage`, `getFirstStage`, `getNextStage`, `evaluateGate`, and `getStageAction`. Uses temp YAML files in the user flows dir.

- [ ] **Step 1: Write the test file**

```ts
/**
 * Tests for flow.ts — load YAML definitions, stage navigation, gate evaluation.
 */

import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import YAML from "yaml";
import {
  createTestContext, setContext, resetContext,
  type TestContext,
} from "../context.js";
import { ARK_DIR } from "../store.js";
import {
  loadFlow, listFlows, getStages, getStage,
  getFirstStage, getNextStage, evaluateGate, getStageAction,
} from "../flow.js";

let ctx: TestContext;
const flowDir = () => join(ARK_DIR, "flows");

function writeFlowYaml(name: string, data: Record<string, unknown>) {
  mkdirSync(flowDir(), { recursive: true });
  writeFileSync(join(flowDir(), `${name}.yaml`), YAML.stringify(data));
}

const TWO_STAGE_FLOW = {
  name: "test-flow",
  description: "A test flow",
  stages: [
    { name: "plan", agent: "planner", gate: "manual" },
    { name: "implement", agent: "implementer", gate: "auto", on_failure: "retry(3)" },
  ],
};

beforeEach(() => {
  if (ctx) ctx.cleanup();
  ctx = createTestContext();
  setContext(ctx);
  // Clean user flow dir to prevent leaking between tests
  rmSync(flowDir(), { recursive: true, force: true });
});

afterAll(() => {
  if (ctx) ctx.cleanup();
  resetContext();
});

// ── loadFlow ───────────────────────────────────────────────────────────────

describe("loadFlow", () => {
  it("returns null for non-existent flow", () => {
    expect(loadFlow("does-not-exist")).toBeNull();
  });

  it("loads a user flow from YAML", () => {
    writeFlowYaml("my-flow", TWO_STAGE_FLOW);
    const flow = loadFlow("my-flow");
    expect(flow).not.toBeNull();
    expect(flow!.name).toBe("test-flow");
    expect(flow!.stages.length).toBe(2);
  });

  it("loads builtin flows (default exists)", () => {
    const flow = loadFlow("default");
    expect(flow).not.toBeNull();
    expect(flow!.name).toBe("default");
  });
});

// ── listFlows ──────────────────────────────────────────────────────────────

describe("listFlows", () => {
  it("includes builtin flows", () => {
    const flows = listFlows();
    const names = flows.map(f => f.name);
    expect(names).toContain("default");
  });

  it("includes user flows", () => {
    writeFlowYaml("custom", { name: "custom", description: "Custom flow", stages: [] });
    const flows = listFlows();
    const custom = flows.find(f => f.name === "custom");
    expect(custom).toBeDefined();
    expect(custom!.source).toBe("user");
  });

  it("user flows override builtins with same name", () => {
    writeFlowYaml("default", { name: "default", description: "My override", stages: [] });
    const flows = listFlows();
    const def = flows.find(f => f.name === "default");
    expect(def!.description).toBe("My override");
    expect(def!.source).toBe("user");
  });
});

// ── getStages / getStage ───────────────────────────────────────────────────

describe("getStages", () => {
  it("returns empty array for unknown flow", () => {
    expect(getStages("nope")).toEqual([]);
  });

  it("returns all stages for a flow", () => {
    writeFlowYaml("staged", TWO_STAGE_FLOW);
    const stages = getStages("staged");
    expect(stages.length).toBe(2);
    expect(stages[0].name).toBe("plan");
    expect(stages[1].name).toBe("implement");
  });
});

describe("getStage", () => {
  it("returns null for unknown stage", () => {
    writeFlowYaml("s", TWO_STAGE_FLOW);
    expect(getStage("s", "nonexistent")).toBeNull();
  });

  it("returns the named stage", () => {
    writeFlowYaml("s", TWO_STAGE_FLOW);
    const stage = getStage("s", "implement");
    expect(stage).not.toBeNull();
    expect(stage!.agent).toBe("implementer");
    expect(stage!.gate).toBe("auto");
  });
});

// ── getFirstStage / getNextStage ───────────────────────────────────────────

describe("getFirstStage", () => {
  it("returns null for unknown flow", () => {
    expect(getFirstStage("nope")).toBeNull();
  });

  it("returns the first stage name", () => {
    writeFlowYaml("f", TWO_STAGE_FLOW);
    expect(getFirstStage("f")).toBe("plan");
  });
});

describe("getNextStage", () => {
  it("returns the next stage", () => {
    writeFlowYaml("f", TWO_STAGE_FLOW);
    expect(getNextStage("f", "plan")).toBe("implement");
  });

  it("returns null at the last stage", () => {
    writeFlowYaml("f", TWO_STAGE_FLOW);
    expect(getNextStage("f", "implement")).toBeNull();
  });

  it("returns null for unknown current stage", () => {
    writeFlowYaml("f", TWO_STAGE_FLOW);
    expect(getNextStage("f", "nonexistent")).toBeNull();
  });
});

// ── evaluateGate ───────────────────────────────────────────────────────────

describe("evaluateGate", () => {
  it("auto gate passes with no error", () => {
    writeFlowYaml("g", TWO_STAGE_FLOW);
    const result = evaluateGate("g", "implement", {});
    expect(result.canProceed).toBe(true);
    expect(result.reason).toContain("auto");
  });

  it("auto gate fails when session has error", () => {
    writeFlowYaml("g", TWO_STAGE_FLOW);
    const result = evaluateGate("g", "implement", { error: "something broke" });
    expect(result.canProceed).toBe(false);
    expect(result.reason).toContain("error");
  });

  it("manual gate always blocks", () => {
    writeFlowYaml("g", TWO_STAGE_FLOW);
    const result = evaluateGate("g", "plan", {});
    expect(result.canProceed).toBe(false);
    expect(result.reason).toContain("manual");
  });

  it("returns canProceed=false for unknown stage", () => {
    writeFlowYaml("g", TWO_STAGE_FLOW);
    const result = evaluateGate("g", "nope", {});
    expect(result.canProceed).toBe(false);
  });

  it("condition gate passes", () => {
    writeFlowYaml("cond", {
      name: "cond", stages: [{ name: "s1", gate: "condition", agent: "x" }],
    });
    const result = evaluateGate("cond", "s1", {});
    expect(result.canProceed).toBe(true);
  });
});

// ── getStageAction ─────────────────────────────────────────────────────────

describe("getStageAction", () => {
  it("returns unknown for non-existent stage", () => {
    expect(getStageAction("nope", "nope").type).toBe("unknown");
  });

  it("returns agent type for agent stages", () => {
    writeFlowYaml("a", TWO_STAGE_FLOW);
    const action = getStageAction("a", "plan");
    expect(action.type).toBe("agent");
    expect(action.agent).toBe("planner");
  });

  it("returns action type for action stages", () => {
    writeFlowYaml("act", {
      name: "act", stages: [{ name: "pr", action: "create_pr", gate: "auto" }],
    });
    const action = getStageAction("act", "pr");
    expect(action.type).toBe("action");
    expect(action.action).toBe("create_pr");
  });

  it("returns fork type with defaults", () => {
    writeFlowYaml("fork", {
      name: "fork", stages: [{ name: "impl", type: "fork", gate: "auto" }],
    });
    const action = getStageAction("fork", "impl");
    expect(action.type).toBe("fork");
    expect(action.agent).toBe("implementer");
    expect(action.strategy).toBe("plan");
    expect(action.max_parallel).toBe(4);
  });

  it("includes on_failure and optional fields", () => {
    writeFlowYaml("opt", {
      name: "opt",
      stages: [{ name: "s", agent: "x", gate: "auto", on_failure: "notify", optional: true }],
    });
    const action = getStageAction("opt", "s");
    expect(action.on_failure).toBe("notify");
    expect(action.optional).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test**

Run: `cd /Users/yana/Projects/ark && npx vitest run packages/core/__tests__/flow.test.ts`

- [ ] **Step 3: Fix any issues, re-run until green**

Note: `loadFlow` loads by filename (`name.yaml`), not by the `name` field inside the YAML. Builtin flow tests reference `loadFlow("default")` which loads `default.yaml` from builtins. Make sure `listFlows` user-override test writes to `default.yaml` so filename matches.

- [ ] **Step 4: Commit**

```bash
git add packages/core/__tests__/flow.test.ts
git commit -m "test: add unit tests for flow loading, navigation, and gate evaluation"
```

---

### Task 3: exec.ts — posix_spawnp integration test

**Files:**
- Test: `packages/core/__tests__/exec.test.ts`

This is a thin FFI wrapper. Test it by spawning `true` (exit 0) and `false` (exit 1).

- [ ] **Step 1: Write the test file**

```ts
/**
 * Tests for exec.ts — posix_spawnp + waitpid wrapper.
 * Integration-style: spawns real processes.
 */

import { describe, it, expect } from "bun:test";
import { spawnAndWait } from "../exec.js";

describe("spawnAndWait", () => {
  it("returns 0 for successful command", () => {
    expect(spawnAndWait("true", [])).toBe(0);
  });

  it("returns 1 for failing command", () => {
    expect(spawnAndWait("false", [])).toBe(1);
  });

  it("passes arguments to the command", () => {
    // echo writes to inherited stdout; we just care it doesn't crash
    expect(spawnAndWait("echo", ["hello", "world"])).toBe(0);
  });

  it("throws for non-existent command", () => {
    expect(() => spawnAndWait("__nonexistent_command_xyz__", [])).toThrow();
  });
});
```

- [ ] **Step 2: Run the test**

Run: `cd /Users/yana/Projects/ark && npx vitest run packages/core/__tests__/exec.test.ts`

- [ ] **Step 3: Fix any issues, re-run until green**

Note: The "throws for non-existent command" test may need adjustment — `posix_spawnp` returns an error code rather than throwing. If `err !== 0` it does throw, but the actual error code depends on the system. If this fails, check whether the function returns a non-zero exit code instead of throwing.

- [ ] **Step 4: Commit**

```bash
git add packages/core/__tests__/exec.test.ts
git commit -m "test: add integration tests for posix_spawnp exec wrapper"
```

---

### Task 4: tmux.ts — helper functions (unit-testable subset)

**Files:**
- Test: `packages/core/__tests__/tmux.test.ts`

Many tmux functions need a real tmux server. Focus on the pure/deterministic helpers: `attachCommand`, `writeLauncher`. For `hasTmux`, `sessionExists`, `killSession` — test the happy paths (tmux is available in CI/dev). Skip `createSession`/`capturePane`/`sendText` — those are covered by E2E tests.

- [ ] **Step 1: Write the test file**

```ts
/**
 * Tests for tmux.ts — pure helpers + basic tmux operations.
 */

import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import {
  createTestContext, setContext, resetContext,
  type TestContext,
} from "../context.js";
import {
  hasTmux, attachCommand, writeLauncher,
  sessionExists, listArkSessions,
} from "../tmux.js";

let ctx: TestContext;

beforeEach(() => {
  if (ctx) ctx.cleanup();
  ctx = createTestContext();
  setContext(ctx);
});

afterAll(() => {
  if (ctx) ctx.cleanup();
  resetContext();
});

// ── hasTmux ────────────────────────────────────────────────────────────────

describe("hasTmux", () => {
  it("returns true when tmux is installed", () => {
    // Assumes dev machines have tmux. Skip in envs where it's absent.
    expect(hasTmux()).toBe(true);
  });
});

// ── attachCommand ──────────────────────────────────────────────────────────

describe("attachCommand", () => {
  it("returns local tmux attach for no host", () => {
    expect(attachCommand("ark-s123")).toBe("tmux attach -t ark-s123");
  });

  it("returns ssh + tmux for remote host", () => {
    const cmd = attachCommand("ark-s123", { host: "10.0.0.1" });
    expect(cmd).toContain("ssh");
    expect(cmd).toContain("ubuntu@10.0.0.1");
    expect(cmd).toContain("tmux attach -t ark-s123");
  });

  it("includes -i flag for custom SSH key", () => {
    const cmd = attachCommand("ark-s123", { host: "10.0.0.1", sshKey: "/path/key.pem" });
    expect(cmd).toContain("-i /path/key.pem");
  });

  it("uses custom user", () => {
    const cmd = attachCommand("ark-s123", { host: "10.0.0.1", user: "ec2-user" });
    expect(cmd).toContain("ec2-user@10.0.0.1");
  });
});

// ── writeLauncher ──────────────────────────────────────────────────────────

describe("writeLauncher", () => {
  it("creates a launch.sh file", () => {
    const path = writeLauncher("s-test123", "#!/bin/bash\necho hello");
    expect(existsSync(path)).toBe(true);
    expect(path).toContain("s-test123");
    expect(path.endsWith("launch.sh")).toBe(true);
  });

  it("file content matches input", () => {
    const content = "#!/bin/bash\necho test";
    const path = writeLauncher("s-content", content);
    expect(readFileSync(path, "utf-8")).toBe(content);
  });

  it("creates parent directory if missing", () => {
    // First call to writeLauncher with new session creates the dir
    const path = writeLauncher("s-newdir", "#!/bin/bash");
    expect(existsSync(path)).toBe(true);
  });
});

// ── sessionExists ──────────────────────────────────────────────────────────

describe("sessionExists", () => {
  it("returns false for non-existent session", () => {
    expect(sessionExists("ark-nonexistent-session-xyz")).toBe(false);
  });
});

// ── listArkSessions ────────────────────────────────────────────────────────

describe("listArkSessions", () => {
  it("returns an array", () => {
    const sessions = listArkSessions();
    expect(Array.isArray(sessions)).toBe(true);
  });

  it("only returns sessions with ark- or s- prefix", () => {
    const sessions = listArkSessions();
    for (const s of sessions) {
      expect(s.name.startsWith("ark-") || s.name.startsWith("s-")).toBe(true);
    }
  });
});
```

- [ ] **Step 2: Run the test**

Run: `cd /Users/yana/Projects/ark && npx vitest run packages/core/__tests__/tmux.test.ts`

- [ ] **Step 3: Fix any issues, re-run until green**

- [ ] **Step 4: Commit**

```bash
git add packages/core/__tests__/tmux.test.ts
git commit -m "test: add unit tests for tmux helpers (attachCommand, writeLauncher, etc.)"
```

---

### Task 5: useStatusMessage hook

**Files:**
- Test: `packages/tui/__tests__/useStatusMessage.test.tsx`

Pure timer-based hook. Test show/clear/auto-clear behavior using `ink-testing-library`.

- [ ] **Step 1: Write the test file**

```tsx
/**
 * Tests for useStatusMessage — temporary status message with auto-clear.
 */

import { describe, it, expect } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { Text } from "ink";
import { useStatusMessage } from "../hooks/useStatusMessage.js";

let statusRef: ReturnType<typeof useStatusMessage> | null = null;

function StatusInspector({ clearMs }: { clearMs?: number }) {
  const status = useStatusMessage(clearMs);
  statusRef = status;
  return <Text>{status.message ?? "empty"}</Text>;
}

describe("useStatusMessage", () => {
  it("starts with null message", () => {
    const { lastFrame, unmount } = render(<StatusInspector />);
    expect(lastFrame()!).toContain("empty");
    unmount();
  });

  it("show() sets the message", async () => {
    const { lastFrame, unmount } = render(<StatusInspector clearMs={5000} />);
    statusRef!.show("Hello");
    await new Promise(r => setTimeout(r, 50));
    expect(lastFrame()!).toContain("Hello");
    unmount();
  });

  it("clear() removes the message immediately", async () => {
    const { lastFrame, unmount } = render(<StatusInspector clearMs={5000} />);
    statusRef!.show("Visible");
    await new Promise(r => setTimeout(r, 50));
    expect(lastFrame()!).toContain("Visible");

    statusRef!.clear();
    await new Promise(r => setTimeout(r, 50));
    expect(lastFrame()!).toContain("empty");
    unmount();
  });

  it("auto-clears after timeout", async () => {
    const { lastFrame, unmount } = render(<StatusInspector clearMs={200} />);
    statusRef!.show("Temporary");
    await new Promise(r => setTimeout(r, 50));
    expect(lastFrame()!).toContain("Temporary");

    await new Promise(r => setTimeout(r, 300));
    expect(lastFrame()!).toContain("empty");
    unmount();
  });

  it("show() resets the timer on repeated calls", async () => {
    const { lastFrame, unmount } = render(<StatusInspector clearMs={200} />);
    statusRef!.show("First");
    await new Promise(r => setTimeout(r, 100));
    statusRef!.show("Second");
    await new Promise(r => setTimeout(r, 150));
    // Should still be visible (timer reset)
    expect(lastFrame()!).toContain("Second");

    await new Promise(r => setTimeout(r, 200));
    expect(lastFrame()!).toContain("empty");
    unmount();
  });
});
```

- [ ] **Step 2: Run the test**

Run: `cd /Users/yana/Projects/ark && npx vitest run packages/tui/__tests__/useStatusMessage.test.tsx`

- [ ] **Step 3: Fix any issues, re-run until green**

- [ ] **Step 4: Commit**

```bash
git add packages/tui/__tests__/useStatusMessage.test.tsx
git commit -m "test: add unit tests for useStatusMessage hook"
```

---

### Task 6: useComputeActions hook

**Files:**
- Test: `packages/tui/__tests__/useComputeActions.test.ts`

This is a plain function (not a React hook despite the name). It takes an `asyncState` and `addLog` callback and returns action functions. Test that each action calls the right provider methods and core updates.

- [ ] **Step 1: Write the test file**

```ts
/**
 * Tests for useComputeActions — compute action dispatcher.
 */

import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import {
  createTestContext, setContext, resetContext,
  createCompute, getCompute,
  type TestContext,
} from "../../core/index.js";
import { registerProvider, clearProviders } from "../../compute/index.js";
import { useComputeActions } from "../hooks/useComputeActions.js";
import type { AsyncState } from "../hooks/useAsync.js";

let ctx: TestContext;

beforeEach(() => {
  if (ctx) ctx.cleanup();
  ctx = createTestContext();
  setContext(ctx);
  clearProviders();
});

afterAll(() => {
  if (ctx) ctx.cleanup();
  resetContext();
  clearProviders();
});

function mockAsyncState(): AsyncState & { ran: { label: string; fn: Function }[] } {
  const state: AsyncState & { ran: { label: string; fn: Function }[] } = {
    loading: false,
    label: null,
    error: null,
    ran: [],
    run(label: string, fn: () => void | Promise<void>) {
      state.ran.push({ label, fn });
      // Execute immediately for testing
      try { fn(); } catch {}
    },
  };
  return state;
}

function mockProvider(name = "mock", overrides: Record<string, Function> = {}) {
  return {
    name,
    provision: overrides.provision ?? (async () => {}),
    stop: overrides.stop ?? (async () => {}),
    start: overrides.start ?? (async () => {}),
    destroy: overrides.destroy ?? (async () => {}),
    getMetrics: overrides.getMetrics ?? (async () => null),
  };
}

describe("useComputeActions", () => {
  it("returns provision, stop, start, delete, clean actions", () => {
    const actions = useComputeActions(mockAsyncState(), () => {});
    expect(typeof actions.provision).toBe("function");
    expect(typeof actions.stop).toBe("function");
    expect(typeof actions.start).toBe("function");
    expect(typeof actions.delete).toBe("function");
    expect(typeof actions.clean).toBe("function");
  });

  it("delete removes compute from store", () => {
    createCompute({ name: "to-delete", provider: "mock" });
    expect(getCompute("to-delete")).not.toBeNull();

    const asyncState = mockAsyncState();
    const actions = useComputeActions(asyncState, () => {});
    actions.delete("to-delete");

    expect(asyncState.ran.length).toBe(1);
    expect(asyncState.ran[0].label).toContain("Deleting");
    expect(getCompute("to-delete")).toBeNull();
  });

  it("provision calls run with correct label", () => {
    registerProvider(mockProvider() as any);
    createCompute({ name: "my-compute", provider: "mock" });
    const compute = getCompute("my-compute")!;

    const asyncState = mockAsyncState();
    const logs: string[] = [];
    const actions = useComputeActions(asyncState, (_, msg) => logs.push(msg));
    actions.provision(compute);

    expect(asyncState.ran.length).toBe(1);
    expect(asyncState.ran[0].label).toContain("Provisioning my-compute");
    expect(logs.some(l => l.includes("provisioning"))).toBe(true);
  });

  it("stop calls run with correct label", () => {
    registerProvider(mockProvider() as any);
    createCompute({ name: "stopper", provider: "mock" });
    const compute = getCompute("stopper")!;

    const asyncState = mockAsyncState();
    const actions = useComputeActions(asyncState, () => {});
    actions.stop(compute);

    expect(asyncState.ran[0].label).toContain("Stopping stopper");
  });

  it("start calls run with correct label", () => {
    registerProvider(mockProvider() as any);
    createCompute({ name: "starter", provider: "mock" });
    const compute = getCompute("starter")!;

    const asyncState = mockAsyncState();
    const actions = useComputeActions(asyncState, () => {});
    actions.start(compute);

    expect(asyncState.ran[0].label).toContain("Starting starter");
  });

  it("provision does nothing when provider not found", () => {
    createCompute({ name: "orphan", provider: "nonexistent" });
    const compute = getCompute("orphan")!;

    const asyncState = mockAsyncState();
    const actions = useComputeActions(asyncState, () => {});
    actions.provision(compute);

    expect(asyncState.ran.length).toBe(0); // no run() call
  });
});
```

- [ ] **Step 2: Run the test**

Run: `cd /Users/yana/Projects/ark && npx vitest run packages/tui/__tests__/useComputeActions.test.ts`

- [ ] **Step 3: Fix any issues**

Note: The mock `run()` executes synchronously. For async actions like `provision` (which uses `Promise.race`), the inner await won't complete. This is fine — the tests validate that `run()` was called with the correct label, not the full async lifecycle. If deeper testing is needed, make `run()` async: `async run(label, fn) { await fn(); }`.

- [ ] **Step 4: Commit**

```bash
git add packages/tui/__tests__/useComputeActions.test.ts
git commit -m "test: add unit tests for useComputeActions dispatcher"
```

---

### Task 7: useAgentOutput hook

**Files:**
- Test: `packages/tui/__tests__/useAgentOutput.test.tsx`

Polls tmux pane output on an interval. Test: returns empty when not running, clears on parameter change. Full polling requires a real tmux session — skip that (E2E covers it).

- [ ] **Step 1: Write the test file**

```tsx
/**
 * Tests for useAgentOutput — tmux pane output polling hook.
 */

import { describe, it, expect } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { Text } from "ink";
import { useAgentOutput } from "../hooks/useAgentOutput.js";

function OutputCapture({ sessionId, tmuxName, isRunning, pollMs }: {
  sessionId: string | null;
  tmuxName: string | null;
  isRunning: boolean;
  pollMs?: number;
}) {
  const output = useAgentOutput(sessionId, tmuxName, isRunning, pollMs);
  return <Text>{output || "no-output"}</Text>;
}

describe("useAgentOutput", () => {
  it("returns empty string when sessionId is null", async () => {
    const { lastFrame, unmount } = render(
      <OutputCapture sessionId={null} tmuxName="ark-test" isRunning={true} />
    );
    await new Promise(r => setTimeout(r, 50));
    expect(lastFrame()!).toContain("no-output");
    unmount();
  });

  it("returns empty string when tmuxName is null", async () => {
    const { lastFrame, unmount } = render(
      <OutputCapture sessionId="s-123" tmuxName={null} isRunning={true} />
    );
    await new Promise(r => setTimeout(r, 50));
    expect(lastFrame()!).toContain("no-output");
    unmount();
  });

  it("returns empty string when not running", async () => {
    const { lastFrame, unmount } = render(
      <OutputCapture sessionId="s-123" tmuxName="ark-test" isRunning={false} />
    );
    await new Promise(r => setTimeout(r, 50));
    expect(lastFrame()!).toContain("no-output");
    unmount();
  });

  it("returns empty for non-existent tmux session", async () => {
    const { lastFrame, unmount } = render(
      <OutputCapture
        sessionId="s-123"
        tmuxName="ark-nonexistent-session-xyz"
        isRunning={true}
        pollMs={100}
      />
    );
    // capturePaneAsync returns "" for non-existent sessions
    await new Promise(r => setTimeout(r, 200));
    expect(lastFrame()!).toContain("no-output");
    unmount();
  });
});
```

- [ ] **Step 2: Run the test**

Run: `cd /Users/yana/Projects/ark && npx vitest run packages/tui/__tests__/useAgentOutput.test.tsx`

- [ ] **Step 3: Fix any issues, re-run until green**

- [ ] **Step 4: Commit**

```bash
git add packages/tui/__tests__/useAgentOutput.test.tsx
git commit -m "test: add unit tests for useAgentOutput hook"
```

---

### Task 8: useComputeMetrics hook

**Files:**
- Test: `packages/tui/__tests__/useComputeMetrics.test.tsx`

Polls provider metrics for running computes. Test: returns empty snapshots when inactive, addLog appends entries with timestamps, log truncation at 50 entries.

- [ ] **Step 1: Write the test file**

```tsx
/**
 * Tests for useComputeMetrics — metrics polling and log management.
 */

import { describe, it, expect } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { Text } from "ink";
import { useComputeMetrics } from "../hooks/useComputeMetrics.js";
import type { Compute } from "../../core/index.js";

let captured: ReturnType<typeof useComputeMetrics> | null = null;

function MetricsCapture({ computes, active, pollMs }: {
  computes: Compute[];
  active: boolean;
  pollMs?: number;
}) {
  const metrics = useComputeMetrics(computes, active, pollMs);
  captured = metrics;
  return <Text>{`fetching=${metrics.fetching} snaps=${metrics.snapshots.size}`}</Text>;
}

describe("useComputeMetrics", () => {
  it("starts with empty snapshots and logs", async () => {
    captured = null;
    const { unmount } = render(<MetricsCapture computes={[]} active={true} />);
    await new Promise(r => setTimeout(r, 50));

    expect(captured!.snapshots.size).toBe(0);
    expect(captured!.logs.size).toBe(0);
    unmount();
  });

  it("addLog appends timestamped entries", async () => {
    captured = null;
    const { unmount } = render(<MetricsCapture computes={[]} active={true} />);
    await new Promise(r => setTimeout(r, 50));

    captured!.addLog("local", "First log");
    captured!.addLog("local", "Second log");
    await new Promise(r => setTimeout(r, 50));

    const logs = captured!.logs.get("local");
    expect(logs).toBeDefined();
    expect(logs!.length).toBe(2);
    // Entries have HH:MM:SS timestamp prefix
    expect(logs![0]).toMatch(/^\d{2}:\d{2}:\d{2}\s+First log$/);
    expect(logs![1]).toMatch(/^\d{2}:\d{2}:\d{2}\s+Second log$/);
    unmount();
  });

  it("addLog caps at 50 entries", async () => {
    captured = null;
    const { unmount } = render(<MetricsCapture computes={[]} active={true} />);
    await new Promise(r => setTimeout(r, 50));

    for (let i = 0; i < 60; i++) {
      captured!.addLog("local", `Log ${i}`);
    }
    await new Promise(r => setTimeout(r, 50));

    const logs = captured!.logs.get("local");
    expect(logs!.length).toBe(50);
    // Should keep the most recent entries
    expect(logs![49]).toContain("Log 59");
    unmount();
  });

  it("does not fetch when inactive", async () => {
    captured = null;
    const { lastFrame, unmount } = render(
      <MetricsCapture computes={[]} active={false} />
    );
    await new Promise(r => setTimeout(r, 50));
    expect(captured!.fetching).toBe(false);
    unmount();
  });

  it("addLog works for multiple computes independently", async () => {
    captured = null;
    const { unmount } = render(<MetricsCapture computes={[]} active={true} />);
    await new Promise(r => setTimeout(r, 50));

    captured!.addLog("compute-a", "Log A");
    captured!.addLog("compute-b", "Log B");
    await new Promise(r => setTimeout(r, 50));

    expect(captured!.logs.get("compute-a")!.length).toBe(1);
    expect(captured!.logs.get("compute-b")!.length).toBe(1);
    expect(captured!.logs.get("compute-a")![0]).toContain("Log A");
    unmount();
  });
});
```

- [ ] **Step 2: Run the test**

Run: `cd /Users/yana/Projects/ark && npx vitest run packages/tui/__tests__/useComputeMetrics.test.tsx`

- [ ] **Step 3: Fix any issues, re-run until green**

- [ ] **Step 4: Commit**

```bash
git add packages/tui/__tests__/useComputeMetrics.test.tsx
git commit -m "test: add unit tests for useComputeMetrics hook"
```

---

### Task 9: Final — run full suite, verify no regressions

- [ ] **Step 1: Run the full test suite**

Run: `cd /Users/yana/Projects/ark && npx vitest run`

- [ ] **Step 2: Fix any failures**

- [ ] **Step 3: Final commit if any fixes needed**

```bash
git commit -m "test: fix test suite issues from coverage expansion"
```
