# Flow Templating — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable `{variable}` substitution in flow YAML definitions so stage descriptions, task prompts, and on_failure actions can reference session data.

**Architecture:** Extract the existing `{variable}` substitution from `agent.ts:resolveAgent` into a shared `substituteVars(template, vars)` helper. Apply it to flow stage fields when a flow is resolved for a session. Add an optional `task` field to `StageDefinition` that gets substituted and passed to the agent as the task prompt.

**Tech Stack:** Existing YAML flow system, existing session variables

---

## File Structure

| File | Change |
|------|--------|
| `packages/core/template.ts` | **Create:** Shared `substituteVars(template, vars)` + `buildSessionVars(session)` |
| `packages/core/agent.ts` | **Modify:** Use shared `substituteVars` instead of inline regex |
| `packages/core/flow.ts` | **Modify:** Add `resolveFlow()` that applies substitution to stage fields. Add `task` field to `StageDefinition`. |
| `packages/core/session.ts` | **Modify:** Use `resolveFlow()` in dispatch, use stage `task` field in `buildTaskWithHandoff` |
| `packages/core/index.ts` | **Modify:** Re-export template + resolveFlow |
| `packages/core/__tests__/template.test.ts` | **Create:** Tests for substituteVars |
| `packages/core/__tests__/flow.test.ts` | **Modify:** Add tests for resolveFlow + task field |
| `packages/core/__tests__/e2e-flow-template.test.ts` | **Create:** E2E test for templated flow dispatch |

---

### Task 1: Extract shared template helper

**Files:**
- Create: `packages/core/template.ts`
- Create: `packages/core/__tests__/template.test.ts`
- Modify: `packages/core/agent.ts`

Create `packages/core/template.ts`:

```ts
/**
 * Template variable substitution — shared by agents and flows.
 * Replaces {variable} placeholders with session data.
 */

import type { Session } from "./store.js";

/** Substitute {variable} placeholders in a template string. Unknown vars preserved as-is. */
export function substituteVars(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, key) => vars[key] ?? `{${key}}`);
}

/** Build the standard variable map from a session. */
export function buildSessionVars(session: Record<string, unknown>): Record<string, string> {
  return {
    ticket: String(session.ticket ?? ""),
    summary: String(session.summary ?? ""),
    jira_key: String(session.ticket ?? ""),
    jira_summary: String(session.summary ?? ""),
    repo: String(session.repo ?? ""),
    branch: String(session.branch ?? ""),
    workdir: String(session.workdir ?? "."),
    track_id: String(session.id ?? ""),
    session_id: String(session.id ?? ""),
    stage: String(session.stage ?? ""),
    flow: String(session.flow ?? ""),
    agent: String(session.agent ?? ""),
    compute: String(session.compute_name ?? "local"),
  };
}
```

Update `agent.ts:resolveAgent` to use the shared helper:

```ts
import { substituteVars, buildSessionVars } from "./template.js";

// In resolveAgent():
const vars = buildSessionVars(session);
if (agent.system_prompt) {
  agent.system_prompt = substituteVars(agent.system_prompt, vars);
}
```

Tests for `template.ts`:
- `substituteVars` replaces known variables
- `substituteVars` preserves unknown variables as `{name}`
- `substituteVars` handles empty string values
- `substituteVars` handles template with no variables
- `buildSessionVars` builds correct map from session object

- [ ] **Step 1: Write tests**
- [ ] **Step 2: Create template.ts**
- [ ] **Step 3: Update agent.ts to use shared helper**
- [ ] **Step 4: Run tests**: `bun test packages/core/__tests__/template.test.ts packages/core/__tests__/agent.test.ts`
- [ ] **Step 5: Commit**

```bash
git commit -m "refactor: extract shared template substitution from agent.ts into template.ts"
```

---

### Task 2: Add resolveFlow with template substitution + task field

**Files:**
- Modify: `packages/core/flow.ts`
- Modify: `packages/core/__tests__/flow.test.ts`

Add `task` field to `StageDefinition`:

```ts
export interface StageDefinition {
  name: string;
  type?: "agent" | "action" | "fork";
  agent?: string;
  action?: string;
  task?: string;  // NEW — template for the agent task prompt
  gate: "auto" | "manual" | "condition";
  on_failure?: string;
  optional?: boolean;
  strategy?: string;
  max_parallel?: number;
  subtasks?: { name: string; task: string }[];
}
```

Add `resolveFlow()`:

```ts
import { substituteVars } from "./template.js";

/** Resolve a flow definition by substituting {variables} in all string fields of each stage. */
export function resolveFlow(flowName: string, vars: Record<string, string>): FlowDefinition | null {
  const flow = loadFlow(flowName);
  if (!flow) return null;

  return {
    ...flow,
    description: flow.description ? substituteVars(flow.description, vars) : undefined,
    stages: flow.stages.map(stage => ({
      ...stage,
      task: stage.task ? substituteVars(stage.task, vars) : undefined,
      on_failure: stage.on_failure ? substituteVars(stage.on_failure, vars) : undefined,
    })),
  };
}
```

Tests:
- `resolveFlow` substitutes variables in stage task field
- `resolveFlow` substitutes variables in description
- `resolveFlow` substitutes variables in on_failure
- `resolveFlow` preserves stages without templates
- `resolveFlow` returns null for unknown flow

Flow YAML example with templates:

```yaml
name: custom-flow
stages:
  - name: implement
    agent: implementer
    gate: auto
    task: "Implement {ticket}: {summary} in {repo}"
  - name: review
    agent: reviewer
    gate: auto
    task: "Review the implementation of {ticket} in {repo}"
```

- [ ] **Step 1: Write tests**
- [ ] **Step 2: Add task field + resolveFlow**
- [ ] **Step 3: Run tests**: `bun test packages/core/__tests__/flow.test.ts`
- [ ] **Step 4: Commit**

```bash
git commit -m "feat: resolveFlow + stage task field — {variable} substitution in flow definitions"
```

---

### Task 3: Wire into session dispatch

**Files:**
- Modify: `packages/core/session.ts`
- Modify: `packages/core/index.ts`

In `dispatch()`, use `resolveFlow` instead of raw `getStageAction`:

```ts
import { buildSessionVars } from "./template.js";
import { resolveFlow } from "./flow.js";

// In dispatch():
const vars = buildSessionVars(session as unknown as Record<string, unknown>);
const resolved = resolveFlow(session.flow, vars);
const stageDef = resolved?.stages.find(s => s.name === stage);
```

In `buildTaskWithHandoff()`, use the stage's `task` field if present:

```ts
// If the stage has a task template, use it instead of the generic prompt
const stageDef = resolveFlow(session.flow, vars)?.stages.find(s => s.name === stage);
if (stageDef?.task) {
  parts.push(stageDef.task);
} else if (isBare) {
  // ... existing bare flow logic
} else {
  // ... existing default logic
}
```

Re-export from `index.ts`:
```ts
export { substituteVars, buildSessionVars } from "./template.js";
export { resolveFlow } from "./flow.js";  // add to existing flow exports
```

- [ ] **Step 1: Wire resolveFlow into dispatch**
- [ ] **Step 2: Wire stage task into buildTaskWithHandoff**
- [ ] **Step 3: Add re-exports**
- [ ] **Step 4: Run tests**: `bun test packages/core/__tests__/session-compute.test.ts packages/core/__tests__/flow.test.ts`
- [ ] **Step 5: Commit**

```bash
git commit -m "feat: wire flow templating into session dispatch — stage task field used as prompt"
```

---

### Task 4: E2E test + push

**Files:**
- Create: `packages/core/__tests__/e2e-flow-template.test.ts`

E2E test: create a flow YAML with `task: "Implement {ticket}: {summary}"`, create a session with ticket + summary, verify that `buildTaskWithHandoff` produces a task containing the substituted values.

Also verify the flow's `resolveFlow` with real session data produces correct stage definitions.

- [ ] **Step 1: Write E2E tests**
- [ ] **Step 2: Run all tests**
- [ ] **Step 3: Commit and push**

```bash
git commit -m "test: E2E tests for flow templating — variable substitution in stage tasks"
git push
```
