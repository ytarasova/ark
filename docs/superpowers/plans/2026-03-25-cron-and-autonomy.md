# Cron Scheduling + Tiered Autonomy — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add recurring scheduled sessions via cron expressions, and tiered autonomy levels per flow stage that control what agents can do.

**Architecture:** Two independent features sharing a plan. Cron: a `schedules` table + `ark schedule` CLI commands + a background poller in the conductor that creates sessions on schedule. Autonomy: an `autonomy` field on `StageDefinition` that maps to Claude Code permission flags and `.claude/settings.local.json` permission rules at dispatch time.

**Tech Stack:** SQLite (schedules table), cron expression parsing (simple custom parser — no dependency), existing flow/session/claude infrastructure

---

# Part A: Cron Scheduling

## File Structure

| File | Change |
|------|--------|
| `packages/core/schedule.ts` | **Create:** Schedule CRUD + cron matcher |
| `packages/core/store.ts` | **Modify:** Add `schedules` table to schema |
| `packages/core/conductor.ts` | **Modify:** Add schedule poller (every 60s) |
| `packages/core/index.ts` | **Modify:** Re-export schedule functions |
| `packages/cli/index.ts` | **Modify:** Add `ark schedule` commands |
| `packages/core/__tests__/schedule.test.ts` | **Create:** Tests |

---

### Task 1: Schedules table + CRUD

**Files:**
- Modify: `packages/core/store.ts` — add `schedules` table
- Create: `packages/core/schedule.ts` — CRUD + cron matching
- Create: `packages/core/__tests__/schedule.test.ts`
- Modify: `packages/core/index.ts`

Add to `store.ts` schema:

```sql
CREATE TABLE IF NOT EXISTS schedules (
  id TEXT PRIMARY KEY,
  cron TEXT NOT NULL,
  flow TEXT NOT NULL DEFAULT 'bare',
  repo TEXT,
  workdir TEXT,
  summary TEXT,
  compute_name TEXT,
  group_name TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_run TEXT,
  created_at TEXT NOT NULL
);
```

Create `schedule.ts`:

```ts
import { randomBytes } from "crypto";
import { getDb } from "./context.js";

export interface Schedule {
  id: string;
  cron: string;
  flow: string;
  repo?: string;
  workdir?: string;
  summary?: string;
  compute_name?: string;
  group_name?: string;
  enabled: boolean;
  last_run?: string;
  created_at: string;
}

export function createSchedule(opts: Omit<Schedule, "id" | "enabled" | "created_at">): Schedule { ... }
export function listSchedules(): Schedule[] { ... }
export function getSchedule(id: string): Schedule | null { ... }
export function deleteSchedule(id: string): boolean { ... }
export function updateScheduleLastRun(id: string): void { ... }
export function enableSchedule(id: string, enabled: boolean): void { ... }

/** Check if a cron expression matches the current minute. */
export function cronMatches(cron: string, now?: Date): boolean { ... }
```

Cron format: `minute hour day-of-month month day-of-week` (standard 5-field). Support `*` and specific values. No ranges or steps needed for v1.

Tests:
- CRUD: create, list, get, delete
- `cronMatches`: `"* * * * *"` always matches, `"0 2 * * *"` matches 2:00 AM, `"30 14 * * 1"` matches Monday 2:30 PM
- `cronMatches`: doesn't match wrong time
- Enable/disable toggle

- [ ] **Step 1: Add schema to store.ts**
- [ ] **Step 2: Write tests**
- [ ] **Step 3: Implement schedule.ts**
- [ ] **Step 4: Add re-exports**
- [ ] **Step 5: Run tests**
- [ ] **Step 6: Commit**

```bash
git commit -m "feat: schedules table + CRUD + cron matching"
```

---

### Task 2: Conductor schedule poller

**Files:**
- Modify: `packages/core/conductor.ts`

Add a `setInterval` (every 60 seconds) in `startConductor` that:
1. Lists all enabled schedules
2. For each, checks if `cronMatches(schedule.cron)` AND `last_run` is not in the current minute
3. If match: creates a session via `startSession()` and dispatches it
4. Updates `last_run`

```ts
// In startConductor, after existing metrics polling:
setInterval(async () => {
  const schedules = listSchedules().filter(s => s.enabled);
  const now = new Date();
  for (const sched of schedules) {
    if (!cronMatches(sched.cron, now)) continue;
    // Skip if already ran this minute
    if (sched.last_run) {
      const lastRun = new Date(sched.last_run);
      if (lastRun.getMinutes() === now.getMinutes() && lastRun.getHours() === now.getHours()) continue;
    }
    try {
      const s = session.startSession({
        summary: sched.summary ?? `Scheduled: ${sched.id}`,
        repo: sched.repo, workdir: sched.workdir,
        flow: sched.flow, compute_name: sched.compute_name, group_name: sched.group_name,
      });
      await session.dispatch(s.id);
      updateScheduleLastRun(sched.id);
    } catch {}
  }
}, 60_000);
```

Tests: hard to unit test (timing), but verify the integration:
- Create a schedule with `"* * * * *"`, verify it would match
- Verify `updateScheduleLastRun` prevents double-fire

- [ ] **Step 1: Add poller**
- [ ] **Step 2: Write integration test**
- [ ] **Step 3: Commit**

```bash
git commit -m "feat: conductor polls schedules every 60s, auto-creates + dispatches sessions"
```

---

### Task 3: CLI commands

**Files:**
- Modify: `packages/cli/index.ts`

```bash
ark schedule add --cron "0 2 * * *" --flow quick --repo /path --summary "Nightly review"
ark schedule list
ark schedule delete <id>
ark schedule enable <id>
ark schedule disable <id>
```

- [ ] **Step 1: Add CLI commands**
- [ ] **Step 2: Test manually**
- [ ] **Step 3: Commit**

```bash
git commit -m "feat: ark schedule CLI — add, list, delete, enable, disable"
```

---

# Part B: Tiered Autonomy

## File Structure

| File | Change |
|------|--------|
| `packages/core/flow.ts` | **Modify:** Add `autonomy` field to `StageDefinition` |
| `packages/core/claude.ts` | **Modify:** `buildArgs` maps autonomy level to Claude flags |
| `packages/core/session.ts` | **Modify:** Pass autonomy from stage to buildArgs |
| `packages/core/__tests__/autonomy.test.ts` | **Create:** Tests |

---

### Task 4: Autonomy levels in flow + claude args

**Files:**
- Modify: `packages/core/flow.ts`
- Modify: `packages/core/claude.ts`
- Modify: `packages/core/session.ts`
- Create: `packages/core/__tests__/autonomy.test.ts`

Add `autonomy` field to `StageDefinition`:

```ts
export interface StageDefinition {
  // ... existing fields
  autonomy?: "full" | "execute" | "edit" | "read-only";
}
```

Autonomy levels map to Claude Code settings:

| Level | `--dangerously-skip-permissions` | `permissions.deny` in settings.local.json |
|---|---|---|
| `full` | yes | none |
| `execute` | yes | none (but hooks could inspect) |
| `edit` | no | `["Bash", "mcp__*"]` |
| `read-only` | no | `["Bash", "Write", "Edit", "mcp__*"]` |

In `claude.ts:buildArgs`, accept an `autonomy` option:

```ts
export interface ClaudeArgsOpts {
  // ... existing
  autonomy?: string;
}

// In buildArgs:
if (opts.autonomy === "full" || opts.autonomy === "execute" || !opts.autonomy) {
  args.push("--dangerously-skip-permissions");
} else {
  // edit or read-only — don't add --dangerously-skip-permissions
  // Permission restrictions go in .claude/settings.local.json via writeHooksConfig
}
```

In `writeHooksConfig`, add permission deny rules based on autonomy:

```ts
export function writeHooksConfig(
  sessionId: string, conductorUrl: string, workdir: string,
  opts?: { autonomy?: string },
): string {
  // ... existing hook config

  // Add permission restrictions for non-full autonomy
  if (opts?.autonomy === "edit") {
    existing.permissions = { deny: ["Bash"] };
  } else if (opts?.autonomy === "read-only") {
    existing.permissions = { deny: ["Bash", "Write", "Edit"] };
  }

  // ... write file
}
```

In `session.ts:launchAgentTmux`, pass the stage autonomy:

```ts
const stageDef = resolved?.stages.find(s => s.name === stage);
const autonomy = stageDef?.autonomy ?? "full";

// Pass to buildClaudeArgs
const claudeArgs = agentRegistry.buildClaudeArgs(agent, { autonomy });

// Pass to writeHooksConfig
claude.writeHooksConfig(session.id, conductorUrl, effectiveWorkdir, { autonomy });
```

Flow YAML example:

```yaml
stages:
  - name: review
    agent: reviewer
    gate: auto
    autonomy: read-only  # reviewer can't modify files
  - name: implement
    agent: implementer
    gate: auto
    autonomy: full  # implementer has full access
```

Tests:
- `buildArgs` with autonomy=full includes `--dangerously-skip-permissions`
- `buildArgs` with autonomy=read-only does NOT include `--dangerously-skip-permissions`
- `buildArgs` with autonomy=edit does NOT include it
- `writeHooksConfig` with autonomy=edit adds Bash to deny list
- `writeHooksConfig` with autonomy=read-only adds Write/Edit/Bash to deny list
- Default autonomy (undefined) = full
- Flow YAML with autonomy field loads correctly

- [ ] **Step 1: Add autonomy to StageDefinition**
- [ ] **Step 2: Write tests**
- [ ] **Step 3: Update buildArgs**
- [ ] **Step 4: Update writeHooksConfig**
- [ ] **Step 5: Wire in session.ts**
- [ ] **Step 6: Run tests**
- [ ] **Step 7: Commit**

```bash
git commit -m "feat: tiered autonomy — full/execute/edit/read-only per flow stage"
```

---

### Task 5: E2E tests for both features + push

**Files:**
- Create: `packages/core/__tests__/e2e-schedule.test.ts`
- Create: `packages/core/__tests__/e2e-autonomy.test.ts`

Schedule E2E: create schedule, verify cronMatches, verify session creation.
Autonomy E2E: create flow with autonomy stages, verify correct flags/permissions.

- [ ] **Step 1: Write E2E tests**
- [ ] **Step 2: Run full suite**
- [ ] **Step 3: Commit and push**

```bash
git commit -m "test: E2E tests for cron scheduling and tiered autonomy"
git push
```
