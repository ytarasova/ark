# Custom Agents Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add project-local and global custom agents with three-tier resolution (project > global > builtin), CLI CRUD commands, and full TUI management.

**Architecture:** Extend `agent.ts` with `findProjectRoot()` and a third resolution tier. Add CLI subcommands (`create`, `edit`, `delete`, `copy`). Upgrade `AgentsTab.tsx` with overlay-based create/edit forms using existing form components.

**Tech Stack:** TypeScript, bun:test, Commander.js (CLI), React + Ink (TUI), YAML

---

### Task 1: Three-Tier Agent Resolution in Core

**Files:**
- Modify: `packages/core/agent.ts`
- Test: `packages/core/__tests__/agent.test.ts`

- [ ] **Step 1: Write failing test for `findProjectRoot()`**

In `packages/core/__tests__/agent.test.ts`, add:

```typescript
import { findProjectRoot } from "../agent.js";

describe("findProjectRoot", () => {
  it("finds .git directory walking up", () => {
    // The test runs inside the ark repo, so cwd has a .git
    const root = findProjectRoot(process.cwd());
    expect(root).not.toBeNull();
    expect(existsSync(join(root!, ".git"))).toBe(true);
  });

  it("returns null when no .git found", () => {
    const root = findProjectRoot("/tmp");
    expect(root).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/core/__tests__/agent.test.ts`
Expected: FAIL — `findProjectRoot` is not exported

- [ ] **Step 3: Implement `findProjectRoot()` in `agent.ts`**

Add after the existing path constants in `packages/core/agent.ts`:

```typescript
/** Walk up from cwd looking for .git/ to find project root. */
export function findProjectRoot(cwd?: string): string | null {
  let dir = cwd ?? process.cwd();
  while (true) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function PROJECT_DIR(root: string) { return join(root, ".ark", "agents"); }
```

Rename `USER_DIR` to `GLOBAL_DIR`:

```typescript
function GLOBAL_DIR() { return join(ARK_DIR(), "agents"); }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/core/__tests__/agent.test.ts`
Expected: PASS

- [ ] **Step 5: Write failing test for three-tier `loadAgent()`**

```typescript
describe("three-tier resolution", () => {
  it("project agent overrides global agent", () => {
    // Create global agent
    writeAgentYaml("my-agent", { name: "my-agent", model: "sonnet" });

    // Create project agent dir
    const projectRoot = ctx.dir;
    const projectAgentDir = join(projectRoot, ".ark", "agents");
    mkdirSync(projectAgentDir, { recursive: true });
    writeFileSync(
      join(projectAgentDir, "my-agent.yaml"),
      YAML.stringify({ name: "my-agent", model: "opus" }),
    );

    const agent = loadAgent("my-agent", projectRoot);
    expect(agent).not.toBeNull();
    expect(agent!.model).toBe("opus");
    expect(agent!._source).toBe("project");
  });

  it("global agent overrides builtin", () => {
    writeAgentYaml("worker", { name: "worker", model: "haiku", description: "custom worker" });
    const agent = loadAgent("worker");
    expect(agent).not.toBeNull();
    expect(agent!.model).toBe("haiku");
    expect(agent!._source).toBe("global");
  });

  it("falls back to builtin when no project or global", () => {
    const agent = loadAgent("worker");
    expect(agent).not.toBeNull();
    expect(agent!._source).toBe("builtin");
  });

  it("loadAgent without projectRoot skips project tier", () => {
    const projectRoot = ctx.dir;
    const projectAgentDir = join(projectRoot, ".ark", "agents");
    mkdirSync(projectAgentDir, { recursive: true });
    writeFileSync(
      join(projectAgentDir, "project-only.yaml"),
      YAML.stringify({ name: "project-only", model: "opus" }),
    );

    // Without projectRoot, project agents are not found
    const agent = loadAgent("project-only");
    expect(agent).toBeNull();

    // With projectRoot, found
    const agent2 = loadAgent("project-only", projectRoot);
    expect(agent2).not.toBeNull();
    expect(agent2!._source).toBe("project");
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `bun test packages/core/__tests__/agent.test.ts`
Expected: FAIL — `loadAgent` doesn't accept `projectRoot` parameter

- [ ] **Step 7: Update `loadAgent()` for three-tier resolution**

Replace the existing `loadAgent` function in `packages/core/agent.ts`:

```typescript
export function loadAgent(name: string, projectRoot?: string): AgentDefinition | null {
  const dirs: [string, AgentDefinition["_source"]][] = [];
  if (projectRoot) dirs.push([PROJECT_DIR(projectRoot), "project"]);
  dirs.push([GLOBAL_DIR(), "global"], [BUILTIN_DIR, "builtin"]);

  for (const [dir, source] of dirs) {
    const path = join(dir, `${name}.yaml`);
    if (existsSync(path)) {
      const raw = YAML.parse(readFileSync(path, "utf-8")) ?? {};
      return { ...DEFAULTS, ...raw, _source: source, _path: path } as AgentDefinition;
    }
  }
  return null;
}
```

- [ ] **Step 8: Run test to verify it passes**

Run: `bun test packages/core/__tests__/agent.test.ts`
Expected: PASS

- [ ] **Step 9: Write failing test for three-tier `listAgents()`**

```typescript
describe("listAgents with project tier", () => {
  it("merges all three tiers, project wins", () => {
    const projectRoot = ctx.dir;
    const projectAgentDir = join(projectRoot, ".ark", "agents");
    mkdirSync(projectAgentDir, { recursive: true });
    writeFileSync(
      join(projectAgentDir, "project-special.yaml"),
      YAML.stringify({ name: "project-special", model: "haiku" }),
    );

    const agents = listAgents(projectRoot);
    const names = agents.map(a => a.name);
    expect(names).toContain("project-special");
    expect(names).toContain("worker"); // builtin still present

    const special = agents.find(a => a.name === "project-special");
    expect(special!._source).toBe("project");
  });

  it("project agent overrides builtin with same name", () => {
    const projectRoot = ctx.dir;
    const projectAgentDir = join(projectRoot, ".ark", "agents");
    mkdirSync(projectAgentDir, { recursive: true });
    writeFileSync(
      join(projectAgentDir, "worker.yaml"),
      YAML.stringify({ name: "worker", model: "haiku", description: "project worker" }),
    );

    const agents = listAgents(projectRoot);
    const worker = agents.find(a => a.name === "worker");
    expect(worker!._source).toBe("project");
    expect(worker!.model).toBe("haiku");
  });
});
```

- [ ] **Step 10: Run test to verify it fails**

Run: `bun test packages/core/__tests__/agent.test.ts`
Expected: FAIL — `listAgents` doesn't accept `projectRoot`

- [ ] **Step 11: Update `listAgents()` for three-tier resolution**

Replace the existing `listAgents` in `packages/core/agent.ts`:

```typescript
export function listAgents(projectRoot?: string): AgentDefinition[] {
  const agents = new Map<string, AgentDefinition>();
  const dirs: [string, AgentDefinition["_source"]][] = [
    [BUILTIN_DIR, "builtin"],
    [GLOBAL_DIR(), "global"],
  ];
  if (projectRoot) dirs.push([PROJECT_DIR(projectRoot), "project"]);

  for (const [dir, source] of dirs) {
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".yaml"))) {
      const raw = YAML.parse(readFileSync(join(dir, file), "utf-8")) ?? {};
      const name = raw.name ?? file.replace(".yaml", "");
      agents.set(name, { ...DEFAULTS, ...raw, name, _source: source, _path: join(dir, file) });
    }
  }
  return [...agents.values()];
}
```

- [ ] **Step 12: Run test to verify it passes**

Run: `bun test packages/core/__tests__/agent.test.ts`
Expected: PASS

- [ ] **Step 13: Write failing test for scope-aware `saveAgent()` and `deleteAgent()`**

```typescript
describe("saveAgent with scope", () => {
  it("saves to global scope", () => {
    const agent = { ...DEFAULTS, name: "test-global" } as AgentDefinition;
    saveAgent(agent, "global");
    const loaded = loadAgent("test-global");
    expect(loaded).not.toBeNull();
    expect(loaded!._source).toBe("global");
  });

  it("saves to project scope", () => {
    const projectRoot = ctx.dir;
    const agent = { ...DEFAULTS, name: "test-project" } as AgentDefinition;
    saveAgent(agent, "project", projectRoot);
    const loaded = loadAgent("test-project", projectRoot);
    expect(loaded).not.toBeNull();
    expect(loaded!._source).toBe("project");
  });
});

describe("deleteAgent with scope", () => {
  it("deletes from project scope", () => {
    const projectRoot = ctx.dir;
    const agent = { ...DEFAULTS, name: "del-me" } as AgentDefinition;
    saveAgent(agent, "project", projectRoot);
    expect(loadAgent("del-me", projectRoot)).not.toBeNull();
    const ok = deleteAgent("del-me", "project", projectRoot);
    expect(ok).toBe(true);
    expect(loadAgent("del-me", projectRoot)).toBeNull();
  });

  it("deletes from global scope", () => {
    const agent = { ...DEFAULTS, name: "del-global" } as AgentDefinition;
    saveAgent(agent, "global");
    expect(loadAgent("del-global")).not.toBeNull();
    const ok = deleteAgent("del-global", "global");
    expect(ok).toBe(true);
    expect(loadAgent("del-global")).toBeNull();
  });

  it("returns false when agent does not exist", () => {
    expect(deleteAgent("nope", "global")).toBe(false);
  });
});
```

- [ ] **Step 14: Run test to verify it fails**

Run: `bun test packages/core/__tests__/agent.test.ts`
Expected: FAIL — `saveAgent` and `deleteAgent` don't accept scope parameters

- [ ] **Step 15: Update `saveAgent()` and `deleteAgent()` signatures**

Replace in `packages/core/agent.ts`:

```typescript
export function saveAgent(agent: AgentDefinition, scope: "project" | "global" = "global", projectRoot?: string): void {
  const dir = scope === "project" && projectRoot ? PROJECT_DIR(projectRoot) : GLOBAL_DIR();
  mkdirSync(dir, { recursive: true });
  const { _source, _path, ...data } = agent;
  writeFileSync(join(dir, `${agent.name}.yaml`), YAML.stringify(data));
}

export function deleteAgent(name: string, scope: "project" | "global" = "global", projectRoot?: string): boolean {
  const dir = scope === "project" && projectRoot ? PROJECT_DIR(projectRoot) : GLOBAL_DIR();
  const path = join(dir, `${name}.yaml`);
  if (existsSync(path)) { unlinkSync(path); return true; }
  return false;
}
```

- [ ] **Step 16: Run test to verify it passes**

Run: `bun test packages/core/__tests__/agent.test.ts`
Expected: PASS

- [ ] **Step 17: Update `resolveAgent()` to accept `projectRoot`**

```typescript
export function resolveAgent(name: string, session: Record<string, unknown>, projectRoot?: string): AgentDefinition | null {
  const agent = loadAgent(name, projectRoot);
  if (!agent) return null;

  const vars = buildSessionVars(session);
  if (agent.system_prompt) {
    agent.system_prompt = substituteVars(agent.system_prompt, vars);
  }
  return agent;
}
```

- [ ] **Step 18: Update `_source` type and exports**

In `packages/core/agent.ts`, update the `AgentDefinition` interface:

```typescript
  _source?: "builtin" | "global" | "project";
```

In `packages/core/index.ts`, update the export to include `findProjectRoot`:

```typescript
export { loadAgent, listAgents, saveAgent, deleteAgent, resolveAgent, buildClaudeArgs, findProjectRoot } from "./agent.js";
```

- [ ] **Step 19: Run all core tests**

Run: `bun test packages/core`
Expected: PASS (existing tests should still pass — `loadAgent("worker")` still works without `projectRoot`)

- [ ] **Step 20: Commit**

```bash
git add packages/core/agent.ts packages/core/__tests__/agent.test.ts packages/core/index.ts
git commit -m "feat: three-tier agent resolution — project > global > builtin

Add findProjectRoot(), PROJECT_DIR, scope-aware saveAgent/deleteAgent.
loadAgent and listAgents accept optional projectRoot parameter.
Rename _source 'user' to 'global', add 'project' source."
```

---

### Task 2: CLI Agent CRUD Commands

**Files:**
- Modify: `packages/cli/index.ts`

- [ ] **Step 1: Update `agent list` to show source column**

Find the existing `agent list` command in `packages/cli/index.ts` and replace it:

```typescript
agent.command("list").description("List agents").option("--project <dir>", "Project root").action((opts) => {
  const projectRoot = opts.project ?? core.findProjectRoot(process.cwd()) ?? undefined;
  for (const a of core.listAgents(projectRoot)) {
    const src = (a._source === "project" ? "P" : a._source === "global" ? "G" : "B").padEnd(2);
    console.log(`  ${src} ${a.name.padEnd(16)} ${a.model.padEnd(8)} T:${a.tools.length} M:${a.mcp_servers.length} S:${a.skills.length} R:${a.memories.length}  ${a.description.slice(0, 40)}`);
  }
});
```

- [ ] **Step 2: Add `agent create` command**

```typescript
agent.command("create").description("Create a new agent").argument("<name>")
  .option("--global", "Save to ~/.ark/agents/ instead of project")
  .action(async (name, opts) => {
    const projectRoot = core.findProjectRoot(process.cwd());
    const scope: "project" | "global" = opts.global || !projectRoot ? "global" : "project";
    const dir = scope === "project" ? join(projectRoot!, ".ark", "agents") : join(core.ARK_DIR(), "agents");
    const filePath = join(dir, `${name}.yaml`);

    if (existsSync(filePath)) {
      console.log(chalk.red(`Agent '${name}' already exists at ${filePath}`));
      return;
    }

    mkdirSync(dir, { recursive: true });
    const scaffold = YAML.stringify({
      name,
      description: "",
      model: "sonnet",
      max_turns: 200,
      system_prompt: "",
      tools: ["Bash", "Read", "Write", "Edit", "Glob", "Grep"],
      mcp_servers: [],
      skills: [],
      memories: [],
      context: [],
      permission_mode: "bypassPermissions",
      env: {},
    });
    writeFileSync(filePath, scaffold);
    console.log(chalk.green(`Created ${scope} agent: ${filePath}`));

    const editor = process.env.EDITOR || "vi";
    const { execFileSync } = await import("child_process");
    execFileSync(editor, [filePath], { stdio: "inherit" });
  });
```

Add these imports at the top of `packages/cli/index.ts` (if not already present):

```typescript
import { existsSync, writeFileSync, mkdirSync, readFileSync } from "fs";
import { join } from "path";
import YAML from "yaml";
```

- [ ] **Step 3: Add `agent edit` command**

```typescript
agent.command("edit").description("Edit an agent definition").argument("<name>").action(async (name) => {
  const projectRoot = core.findProjectRoot(process.cwd()) ?? undefined;
  const a = core.loadAgent(name, projectRoot);
  if (!a) { console.log(chalk.red(`Agent '${name}' not found`)); return; }

  if (a._source === "builtin") {
    const readline = await import("readline");
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise<string>(resolve => rl.question(
      `'${name}' is a builtin agent. Copy to project/global first? [p/g/N] `, resolve,
    ));
    rl.close();
    const choice = answer.trim().toLowerCase();
    if (choice === "p" && projectRoot) {
      core.saveAgent(a, "project", projectRoot);
      const path = join(projectRoot, ".ark", "agents", `${name}.yaml`);
      const editor = process.env.EDITOR || "vi";
      const { execFileSync } = await import("child_process");
      execFileSync(editor, [path], { stdio: "inherit" });
    } else if (choice === "g") {
      core.saveAgent(a, "global");
      const path = join(core.ARK_DIR(), "agents", `${name}.yaml`);
      const editor = process.env.EDITOR || "vi";
      const { execFileSync } = await import("child_process");
      execFileSync(editor, [path], { stdio: "inherit" });
    } else {
      console.log("Cancelled.");
    }
    return;
  }

  const editor = process.env.EDITOR || "vi";
  const { execFileSync } = await import("child_process");
  execFileSync(editor, [a._path!], { stdio: "inherit" });
});
```

- [ ] **Step 4: Add `agent delete` command**

```typescript
agent.command("delete").description("Delete a custom agent").argument("<name>").action(async (name) => {
  const projectRoot = core.findProjectRoot(process.cwd()) ?? undefined;
  const a = core.loadAgent(name, projectRoot);
  if (!a) { console.log(chalk.red(`Agent '${name}' not found`)); return; }

  if (a._source === "builtin") {
    console.log(chalk.red("Cannot delete builtin agents."));
    return;
  }

  const readline = await import("readline");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>(resolve => rl.question(
    `Delete ${a._source} agent '${name}' at ${a._path}? [y/N] `, resolve,
  ));
  rl.close();

  if (answer.trim().toLowerCase() === "y") {
    const scope = a._source as "project" | "global";
    core.deleteAgent(name, scope, scope === "project" ? projectRoot : undefined);
    console.log(chalk.green(`Deleted '${name}'.`));
  } else {
    console.log("Cancelled.");
  }
});
```

- [ ] **Step 5: Add `agent copy` command**

```typescript
agent.command("copy").description("Copy an agent for customization").argument("<name>").argument("[new-name]")
  .option("--global", "Save to ~/.ark/agents/ instead of project")
  .action((name, newName, opts) => {
    const projectRoot = core.findProjectRoot(process.cwd()) ?? undefined;
    const a = core.loadAgent(name, projectRoot);
    if (!a) { console.log(chalk.red(`Agent '${name}' not found`)); return; }

    const targetName = newName || name;
    const scope: "project" | "global" = opts.global || !projectRoot ? "global" : "project";
    const copy = { ...a, name: targetName };
    core.saveAgent(copy, scope, scope === "project" ? projectRoot : undefined);

    const dir = scope === "project" ? join(projectRoot!, ".ark", "agents") : join(core.ARK_DIR(), "agents");
    console.log(chalk.green(`Copied '${name}' → ${scope} '${targetName}' at ${join(dir, `${targetName}.yaml`)}`));
  });
```

- [ ] **Step 6: Test CLI commands manually**

Run:
```bash
cd /path/to/any/git/repo
ark agent list
ark agent copy worker my-worker
ark agent list
ark agent show my-worker
ark agent delete my-worker
```
Expected: List shows P/G/B source column, copy/delete work

- [ ] **Step 7: Commit**

```bash
git add packages/cli/index.ts
git commit -m "feat: CLI agent CRUD — create, edit, delete, copy commands

ark agent create/edit/delete/copy with --global flag.
Default scope is project (.ark/agents/), falls back to global.
Agent list now shows P/G/B source column."
```

---

### Task 3: Update `useStore` and `AgentsTab` for Project Root

**Files:**
- Modify: `packages/tui/hooks/useStore.ts`
- Modify: `packages/tui/tabs/AgentsTab.tsx`

- [ ] **Step 1: Pass `projectRoot` through `useStore` data loading**

In `packages/tui/hooks/useStore.ts`, find where `core.listAgents()` is called (appears twice — in `loadData()` and in the initial state). Update both to pass a project root:

```typescript
// At the top of the file or inside loadData, compute project root once:
const projectRoot = core.findProjectRoot(process.cwd()) ?? undefined;

// Then replace core.listAgents() calls with:
agents: core.listAgents(projectRoot),
```

- [ ] **Step 2: Update `AgentsTab` source indicator**

In `packages/tui/tabs/AgentsTab.tsx`, update the `renderRow` to use the new source values:

```typescript
renderRow={(a) => {
  const marker = agents.indexOf(a) === sel ? ">" : " ";
  const src = a._source === "project" ? "P" : a._source === "global" ? "G" : "B";
  return `${marker} ${src} ${a.name.padEnd(16)} ${a.model.padEnd(8)} ${a.description.slice(0, 30)}`;
}}
```

And in `AgentDetail`, the `_source` display already works since it just prints the value.

- [ ] **Step 3: Build and verify**

Run: `make dev` (or `npx tsc`) to check no type errors, then `make tui` to visually verify agents tab shows P/G/B.

- [ ] **Step 4: Commit**

```bash
git add packages/tui/hooks/useStore.ts packages/tui/tabs/AgentsTab.tsx
git commit -m "feat: TUI agents tab shows project/global/builtin source

useStore passes projectRoot to listAgents. Source column shows P/G/B."
```

---

### Task 4: TUI Agent Create/Edit Form

**Files:**
- Create: `packages/tui/forms/AgentForm.tsx`
- Modify: `packages/tui/tabs/AgentsTab.tsx`

- [ ] **Step 1: Create `AgentForm.tsx`**

Create `packages/tui/forms/AgentForm.tsx`:

```tsx
import React, { useState } from "react";
import { Box, Text } from "ink";
import * as core from "../../core/index.js";
import { useFormNavigation } from "../components/form/useFormNavigation.js";
import { FormTextField } from "../components/form/FormTextField.js";
import { FormSelectField } from "../components/form/FormSelectField.js";
import { submitForm } from "../components/form/submitForm.js";
import type { AsyncState } from "../hooks/useAsync.js";

interface AgentFormProps {
  agent?: core.AgentDefinition | null; // null = create mode
  onDone: () => void;
  asyncState: AsyncState;
  projectRoot?: string;
}

const MODEL_CHOICES = [
  { label: "opus", value: "opus" },
  { label: "sonnet", value: "sonnet" },
  { label: "haiku", value: "haiku" },
];

const TOOL_OPTIONS = ["Bash", "Read", "Write", "Edit", "Glob", "Grep", "WebSearch"];

const PERMISSION_CHOICES = [
  { label: "bypassPermissions", value: "bypassPermissions" },
  { label: "default", value: "default" },
];

const SCOPE_CHOICES = [
  { label: "project", value: "project" },
  { label: "global", value: "global" },
];

export function AgentForm({ agent, onDone, asyncState, projectRoot }: AgentFormProps) {
  const isEdit = !!agent;

  const [name, setName] = useState(agent?.name ?? "");
  const [description, setDescription] = useState(agent?.description ?? "");
  const [model, setModel] = useState(agent?.model ?? "sonnet");
  const [maxTurns, setMaxTurns] = useState(String(agent?.max_turns ?? 200));
  const [tools, setTools] = useState<string[]>(agent?.tools ?? ["Bash", "Read", "Write", "Edit", "Glob", "Grep"]);
  const [permissionMode, setPermissionMode] = useState(agent?.permission_mode ?? "bypassPermissions");
  const [scope, setScope] = useState<"project" | "global">(
    agent?._source === "global" ? "global" : projectRoot ? "project" : "global",
  );

  const { active, advance, setEditing } = useFormNavigation({
    fields: [
      { name: "name", type: "text", visible: !isEdit },
      { name: "description", type: "text" },
      { name: "model", type: "select" },
      { name: "max_turns", type: "text" },
      { name: "tools", type: "text" },
      { name: "permission", type: "select" },
      { name: "scope", type: "select", visible: !isEdit },
      { name: "prompt", type: "text" },
    ],
    onCancel: onDone,
    onSubmit: submit,
  });

  function submit() {
    if (!isEdit && !name.trim()) return;

    const agentDef: core.AgentDefinition = {
      name: isEdit ? agent!.name : name.trim(),
      description,
      model,
      max_turns: parseInt(maxTurns) || 200,
      system_prompt: agent?.system_prompt ?? "",
      tools,
      mcp_servers: agent?.mcp_servers ?? [],
      skills: agent?.skills ?? [],
      memories: agent?.memories ?? [],
      context: agent?.context ?? [],
      permission_mode: permissionMode,
      env: agent?.env ?? {},
    };

    const saveScope = isEdit ? (agent!._source as "project" | "global") : scope;

    submitForm({
      create: () => {
        core.saveAgent(agentDef, saveScope, saveScope === "project" ? projectRoot : undefined);
      },
      onDone,
      asyncState,
    });
  }

  function toggleTool(tool: string) {
    setTools(prev => prev.includes(tool) ? prev.filter(t => t !== tool) : [...prev, tool]);
  }

  return (
    <Box flexDirection="column" flexGrow={1}>
      <Text bold color="cyan">{isEdit ? ` Edit: ${agent!.name}` : " New Agent"}</Text>
      <Text> </Text>

      {!isEdit && (
        <FormTextField
          label="Name"
          value={name}
          onChange={setName}
          active={active === "name"}
          onEditChange={setEditing}
        />
      )}

      <FormTextField
        label="Desc"
        value={description}
        onChange={setDescription}
        active={active === "description"}
        onEditChange={setEditing}
      />

      <FormSelectField
        label="Model"
        value={model}
        items={MODEL_CHOICES}
        onSelect={(v) => { setModel(v); advance(); }}
        active={active === "model"}
        displayValue={model}
      />

      <FormTextField
        label="Max turns"
        value={maxTurns}
        onChange={setMaxTurns}
        active={active === "max_turns"}
        onEditChange={setEditing}
      />

      {/* Tools as inline toggle list */}
      <Box>
        <Text color={active === "tools" ? "cyan" : "gray"}>
          {active === "tools" ? "> " : "  "}
        </Text>
        <Text color={active === "tools" ? "white" : "gray"} bold={active === "tools"}>
          {"Tools     "}
        </Text>
        <Text>
          {TOOL_OPTIONS.map(t =>
            tools.includes(t) ? `[x]${t}` : `[ ]${t}`,
          ).join(" ")}
        </Text>
      </Box>

      <FormSelectField
        label="Permission"
        value={permissionMode}
        items={PERMISSION_CHOICES}
        onSelect={(v) => { setPermissionMode(v); advance(); }}
        active={active === "permission"}
        displayValue={permissionMode}
      />

      {!isEdit && (
        <FormSelectField
          label="Scope"
          value={scope}
          items={projectRoot ? SCOPE_CHOICES : [{ label: "global", value: "global" }]}
          onSelect={(v) => { setScope(v as "project" | "global"); advance(); }}
          active={active === "scope"}
          displayValue={scope}
        />
      )}

      {/* System prompt — opens $EDITOR */}
      <Box>
        <Text color={active === "prompt" ? "cyan" : "gray"}>
          {active === "prompt" ? "> " : "  "}
        </Text>
        <Text color={active === "prompt" ? "white" : "gray"} bold={active === "prompt"}>
          {"Prompt    "}
        </Text>
        <Text dimColor>
          {agent?.system_prompt
            ? `${agent.system_prompt.split("\n")[0].slice(0, 40)}...`
            : "(empty — press Enter to edit in $EDITOR)"}
        </Text>
      </Box>
    </Box>
  );
}
```

- [ ] **Step 2: Run type check**

Run: `npx tsc --noEmit`
Expected: No errors in AgentForm.tsx (may need to adjust imports based on actual form component signatures)

- [ ] **Step 3: Commit**

```bash
git add packages/tui/forms/AgentForm.tsx
git commit -m "feat: AgentForm component for TUI agent create/edit

Form with name, description, model, max_turns, tools, permissions,
scope fields. Uses existing form components and useFormNavigation."
```

---

### Task 5: Wire AgentForm into AgentsTab with Keybindings

**Files:**
- Modify: `packages/tui/tabs/AgentsTab.tsx`
- Modify: `packages/tui/components/StatusBar.tsx`
- Modify: `packages/tui/App.tsx`

- [ ] **Step 1: Add overlay state and keybindings to `AgentsTab`**

Replace the entire `packages/tui/tabs/AgentsTab.tsx`:

```tsx
import React, { useMemo, useState, useCallback } from "react";
import { Box, Text, useInput } from "ink";
import * as core from "../../core/index.js";
import { SplitPane } from "../components/SplitPane.js";
import { TreeList } from "../components/TreeList.js";
import { DetailPanel } from "../components/DetailPanel.js";
import { SectionHeader } from "../components/SectionHeader.js";
import { useListNavigation } from "../hooks/useListNavigation.js";
import { useStatusMessage } from "../hooks/useStatusMessage.js";
import { AgentForm } from "../forms/AgentForm.js";
import type { StoreData } from "../hooks/useStore.js";
import type { AsyncState } from "../hooks/useAsync.js";

interface AgentsTabProps extends StoreData {
  pane: "left" | "right";
  asyncState: AsyncState;
  onOverlayChange?: (overlay: string | null) => void;
  refresh: () => void;
}

export function AgentsTab({ agents, pane, asyncState, onOverlayChange, refresh }: AgentsTabProps) {
  const [formMode, setFormMode] = useState<"create" | "edit" | null>(null);
  const [copyMode, setCopyMode] = useState(false);
  const hasOverlay = formMode !== null || copyMode;
  const { sel } = useListNavigation(agents.length, { active: pane === "left" && !hasOverlay });
  const status = useStatusMessage();
  const projectRoot = useMemo(() => core.findProjectRoot(process.cwd()) ?? undefined, []);

  const selected = agents[sel] ?? null;

  // Signal overlay to parent
  React.useEffect(() => {
    onOverlayChange?.(formMode ? "form" : copyMode ? "clone" : null);
  }, [formMode, copyMode]);

  const closeForm = useCallback(() => {
    setFormMode(null);
    setCopyMode(false);
    refresh();
  }, [refresh]);

  useInput((input, key) => {
    if (hasOverlay || pane !== "left") return;

    // n = create
    if (input === "n") {
      setFormMode("create");
      return;
    }

    if (!selected) return;

    // e = edit
    if (input === "e") {
      if (selected._source === "builtin") {
        status.show("Cannot edit builtin — press 'c' to copy first");
        return;
      }
      setFormMode("edit");
      return;
    }

    // c = copy
    if (input === "c") {
      const copyName = `${selected.name}-copy`;
      const scope = projectRoot ? "project" : "global";
      asyncState.run("Copying agent...", () => {
        core.saveAgent({ ...selected, name: copyName }, scope, scope === "project" ? projectRoot : undefined);
        status.show(`Copied '${selected.name}' → '${copyName}' (${scope})`);
        refresh();
      });
      return;
    }

    // x = delete
    if (input === "x") {
      if (selected._source === "builtin") {
        status.show("Cannot delete builtin agents");
        return;
      }
      const scope = selected._source as "project" | "global";
      asyncState.run("Deleting agent...", () => {
        core.deleteAgent(selected.name, scope, scope === "project" ? projectRoot : undefined);
        status.show(`Deleted '${selected.name}'`);
        refresh();
      });
      return;
    }
  });

  return (
    <SplitPane
      focus={pane}
      leftTitle="Agents"
      rightTitle={formMode ? (formMode === "create" ? "New Agent" : "Edit Agent") : "Details"}
      left={
        <TreeList
          items={agents}
          renderRow={(a) => {
            const marker = agents.indexOf(a) === sel ? ">" : " ";
            const src = a._source === "project" ? "P" : a._source === "global" ? "G" : "B";
            return `${marker} ${src} ${a.name.padEnd(16)} ${a.model.padEnd(8)} ${a.description.slice(0, 30)}`;
          }}
          sel={sel}
          emptyMessage="No agents found."
        />
      }
      right={
        formMode ? (
          <AgentForm
            agent={formMode === "edit" ? selected : null}
            onDone={closeForm}
            asyncState={asyncState}
            projectRoot={projectRoot}
          />
        ) : (
          <AgentDetail agent={selected} pane={pane} status={status} />
        )
      }
    />
  );
}

// ── Detail ──────────────────────────────────────────────────────────────────

interface AgentDetailProps {
  agent: ReturnType<typeof core.listAgents>[number] | null;
  pane: "left" | "right";
  status: ReturnType<typeof useStatusMessage>;
}

function AgentDetail({ agent, pane, status }: AgentDetailProps) {
  if (!agent) {
    return <Box flexGrow={1}><Text dimColor>{"  No agent selected"}</Text></Box>;
  }

  const a = useMemo(() => {
    try { return core.loadAgent(agent.name); } catch { return null; }
  }, [agent.name]);
  if (!a) {
    return <Text dimColor>{"  Failed to load agent"}</Text>;
  }

  const sections: [string, string[]][] = [
    ["Tools", a.tools],
    ["MCP Servers", a.mcp_servers.map(String)],
    ["Skills", a.skills],
    ["Memories", a.memories],
    ["Context", a.context],
  ];

  return (
    <DetailPanel active={pane === "right"}>
      <Text bold>{` ${a.name}`}<Text dimColor>{` (${a._source})`}</Text></Text>
      {a.description && <Text dimColor>{` ${a.description}`}</Text>}
      {status.message && <Text color="yellow">{` ${status.message}`}</Text>}

      <Text> </Text>
      <SectionHeader title="Config" />
      <Text>{`  Model:      ${a.model}`}</Text>
      <Text>{`  Max turns:  ${a.max_turns}`}</Text>
      <Text>{`  Permission: ${a.permission_mode}`}</Text>

      {sections.map(([title, items]) => (
        <React.Fragment key={title}>
          <Text> </Text>
          <SectionHeader title={`${title} (${items.length})`} />
          {items.length > 0 ? (
            items.map((item, i) => <Text key={i}>{`  * ${item}`}</Text>)
          ) : (
            <Text dimColor>{"  (none)"}</Text>
          )}
        </React.Fragment>
      ))}

      {a.system_prompt && (
        <>
          <Text> </Text>
          <SectionHeader title="System Prompt" />
          {a.system_prompt.split("\n").map((line, i) => (
            <Text key={i} dimColor>{`  ${line}`}</Text>
          ))}
        </>
      )}
    </DetailPanel>
  );
}
```

- [ ] **Step 2: Update `App.tsx` to pass new props to `AgentsTab`**

Find the `AgentsTab` render in `packages/tui/App.tsx` and update it to pass `asyncState`, `onOverlayChange`, and `refresh`:

```tsx
) : tab === "agents" ? (
  <AgentsTab
    {...store}
    pane={pane}
    asyncState={asyncState}
    onOverlayChange={setActiveOverlay}
    refresh={store.refresh}
  />
)
```

- [ ] **Step 3: Update `StatusBar` agent hints**

In `packages/tui/components/StatusBar.tsx`, replace `getAgentsHints()`:

```typescript
function getAgentsHints(): React.ReactNode[] {
  sepId = 0;
  return [
    ...NAV_HINTS, sep(),
    <KeyHint key="n" k="n" label="new" />,
    <KeyHint key="e" k="e" label="edit" />,
    <KeyHint key="c" k="c" label="copy" />,
    <KeyHint key="x" k="x" label="delete" />, sep(),
    <KeyHint key="q" k="q" label="quit" />,
  ];
}
```

- [ ] **Step 4: Build and verify**

Run: `npx tsc --noEmit` then `make tui`
Expected: Agents tab shows CRUD hints in status bar. `n` opens create form, `e` opens edit form, `c` copies, `x` deletes.

- [ ] **Step 5: Commit**

```bash
git add packages/tui/tabs/AgentsTab.tsx packages/tui/forms/AgentForm.tsx packages/tui/App.tsx packages/tui/components/StatusBar.tsx
git commit -m "feat: TUI agent CRUD — create, edit, copy, delete in agents tab

New AgentForm overlay for create/edit. Keybindings: n/e/c/x.
StatusBar shows agent-specific hints. Overlay signals parent."
```

---

### Task 6: System Prompt $EDITOR Integration

**Files:**
- Modify: `packages/tui/forms/AgentForm.tsx`

- [ ] **Step 1: Add $EDITOR launch for system prompt field**

In `AgentForm.tsx`, add state and handler for the system prompt. When the user presses Enter on the "prompt" field, write the current prompt to a temp file, spawn `$EDITOR`, then read it back.

Add to the component:

```typescript
import { writeFileSync, readFileSync, mkdtempSync } from "fs";
import { join } from "path";
import { execFileSync } from "child_process";

const [systemPrompt, setSystemPrompt] = useState(agent?.system_prompt ?? "");
```

Update the `useFormNavigation` `fields` to change the prompt field type:

```typescript
{ name: "prompt", type: "action" },
```

Add input handler for the prompt field (inside the component, after the `useFormNavigation` call):

```typescript
useInput((input, key) => {
  if (active === "prompt" && key.return) {
    const tmpDir = mkdtempSync(join(require("os").tmpdir(), "ark-agent-"));
    const tmpFile = join(tmpDir, "system-prompt.md");
    writeFileSync(tmpFile, systemPrompt);
    const editor = process.env.EDITOR || "vi";
    try {
      execFileSync(editor, [tmpFile], { stdio: "inherit" });
      const edited = readFileSync(tmpFile, "utf-8");
      setSystemPrompt(edited);
    } catch {}
  }
});
```

Update the `submit()` function to use `systemPrompt` state:

```typescript
system_prompt: systemPrompt,
```

Update the prompt display at the bottom of the form:

```tsx
<Box>
  <Text color={active === "prompt" ? "cyan" : "gray"}>
    {active === "prompt" ? "> " : "  "}
  </Text>
  <Text color={active === "prompt" ? "white" : "gray"} bold={active === "prompt"}>
    {"Prompt    "}
  </Text>
  <Text dimColor>
    {systemPrompt
      ? `${systemPrompt.split("\n")[0].slice(0, 40)}... (Enter to edit)`
      : "(empty — Enter to edit in $EDITOR)"}
  </Text>
</Box>
```

- [ ] **Step 2: Build and verify**

Run: `npx tsc --noEmit`
Expected: No type errors

- [ ] **Step 3: Commit**

```bash
git add packages/tui/forms/AgentForm.tsx
git commit -m "feat: $EDITOR integration for agent system prompt editing

Press Enter on prompt field to open system prompt in $EDITOR.
Writes to temp file, reads back edited content."
```

---

### Task 7: Thread `projectRoot` Through Session Dispatch

**Files:**
- Modify: `packages/core/session.ts`

- [ ] **Step 1: Find where `resolveAgent` is called in session.ts and thread `projectRoot`**

In `packages/core/session.ts`, find the `dispatch()` function where `resolveAgent()` is called. Add `findProjectRoot` to the imports and pass the project root through:

```typescript
import { resolveAgent, buildClaudeArgs, findProjectRoot } from "./agent.js";
```

At the point where `resolveAgent` is called, add:

```typescript
const projectRoot = findProjectRoot(session.workdir || session.repo) ?? undefined;
const agent = resolveAgent(agentName, session as unknown as Record<string, unknown>, projectRoot);
```

This ensures that when a session dispatches an agent, it resolves from the session's working directory — picking up project-local agents.

- [ ] **Step 2: Run existing tests**

Run: `bun test packages/core`
Expected: PASS — the `projectRoot` parameter is optional so existing behavior unchanged

- [ ] **Step 3: Commit**

```bash
git add packages/core/session.ts
git commit -m "feat: session dispatch resolves agents from project workdir

Threads findProjectRoot through dispatch → resolveAgent so
project-local agents are found when dispatching sessions."
```

---

### Task 8: Final Integration Test

**Files:**
- Modify: `packages/core/__tests__/agent.test.ts`

- [ ] **Step 1: Add integration test for full agent lifecycle**

```typescript
describe("full agent lifecycle", () => {
  it("create → list → load → delete round-trip for project scope", () => {
    const projectRoot = ctx.dir;

    // Create a project agent
    const agent = {
      ...DEFAULTS,
      name: "lifecycle-test",
      description: "Integration test agent",
      model: "haiku",
    } as AgentDefinition;
    saveAgent(agent, "project", projectRoot);

    // List includes it
    const agents = listAgents(projectRoot);
    const found = agents.find(a => a.name === "lifecycle-test");
    expect(found).not.toBeNull();
    expect(found!._source).toBe("project");

    // Load returns it
    const loaded = loadAgent("lifecycle-test", projectRoot);
    expect(loaded!.model).toBe("haiku");

    // Delete removes it
    deleteAgent("lifecycle-test", "project", projectRoot);
    expect(loadAgent("lifecycle-test", projectRoot)).toBeNull();
  });

  it("project agent shadows global agent with same name", () => {
    const projectRoot = ctx.dir;

    // Create global
    saveAgent({ ...DEFAULTS, name: "shadow-test", model: "sonnet" } as AgentDefinition, "global");

    // Create project with same name
    saveAgent({ ...DEFAULTS, name: "shadow-test", model: "opus" } as AgentDefinition, "project", projectRoot);

    // Load returns project version
    const loaded = loadAgent("shadow-test", projectRoot);
    expect(loaded!.model).toBe("opus");
    expect(loaded!._source).toBe("project");

    // Delete project version, global still there
    deleteAgent("shadow-test", "project", projectRoot);
    const fallback = loadAgent("shadow-test", projectRoot);
    expect(fallback!.model).toBe("sonnet");
    expect(fallback!._source).toBe("global");
  });
});
```

- [ ] **Step 2: Run all tests**

Run: `bun test packages/core/__tests__/agent.test.ts`
Expected: PASS

- [ ] **Step 3: Run full test suite**

Run: `bun test packages/core`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add packages/core/__tests__/agent.test.ts
git commit -m "test: integration tests for agent lifecycle and shadowing

Tests project→global→builtin resolution, scope-aware CRUD,
and project-shadows-global behavior."
```
