# Conductor.build Gap Closure Plan

**Date:** 2026-04-07
**Context:** Competitive analysis of [conductor.build](https://www.conductor.build/) identified 10 gaps in Ark. This plan addresses all of them in priority order, grounded in the actual codebase architecture.

---

## Summary

Conductor.build is a macOS desktop app for running parallel Claude Code + Codex agents in isolated git worktrees with a polished review/merge GUI. Ark competes on orchestration depth (multi-compute, flows, CI mode, guardrails, observability). The gaps are UX and integration features that Conductor does well.

| Phase | Features | Effort | Impact |
|-------|----------|--------|--------|
| **A** | Agent interrupt, diff preview | 1-2 sessions | HIGH -- daily UX |
| **B** | PR creation + GitHub sync, multi-model executor | 2-3 sessions | HIGH -- workflow completeness |
| **C** | Verification gates (todos + verify scripts) | 1-2 sessions | HIGH -- agent quality enforcement |
| **D** | Archive/restore, diff re-review flagging | 1 session | LOW -- polish |

**Descoped:** Per-turn cost tracking, file-scoped task delegation -- not pursuing.

---

## Phase A: Core UX (highest daily impact)

### A1. Agent Interrupt (Pause Without Kill)

**Problem:** Ark's `stop()` kills the tmux session. Conductor lets you pause an agent (Option+T) without termination. Ark's `pause()` is DB-only and doesn't touch the running process.

**Architecture:** `tmux.sendKeysAsync(name, "C-c")` can send SIGINT to Claude Code without destroying the tmux session. Claude Code handles Ctrl+C by stopping its current operation and returning to its prompt.

**Implementation:**

1. **Add `interrupt()` to session-orchestration.ts** (alongside `stop`):
   ```ts
   export async function interrupt(sessionId: string): Promise<SessionOpResult> {
     const session = getApp().sessions.get(sessionId);
     if (!session?.session_id) return { ok: false, message: "Not running" };
     await tmux.sendKeysAsync(session.session_id, "C-c");
     getApp().sessions.update(sessionId, { status: "waiting" });
     getApp().events.log(sessionId, "session_interrupted", { stage: session.stage, actor: "user" });
     return { ok: true, message: "Interrupted" };
   }
   ```

2. **Export from core/index.ts**, add RPC handler `session/interrupt` in server/handlers/session.ts

3. **Add `ArkClient.sessionInterrupt(id)`** in protocol/client.ts

4. **TUI:** Bind to `i` key (or remap existing). Show "Interrupt" button when status is "running"

5. **Web UI:** Add "Interrupt" button in SessionDetail.tsx actions when running

6. **CLI:** `ark session interrupt <id>`

**Files:** session-orchestration.ts, tmux.ts (already has sendKeysAsync), index.ts, server/handlers/session.ts, protocol/client.ts, SessionsTab.tsx, SessionDetail.tsx (web), cli/index.ts

**Risk:** Claude Code may not always return to a clean prompt state after Ctrl+C. Add a 3s timeout poll via `capturePaneAsync` to detect if Claude returned to idle. If not, fall back to `stop()`.

---

### A2. Diff Preview Before Worktree Finish

**Problem:** Ark's worktree finish (TUI `W`, CLI `ark worktree finish`) merges immediately with no diff preview. Conductor has a dedicated diff viewer (Cmd+D).

**Implementation:**

1. **Add `worktreeDiff(sessionId)` to session-orchestration.ts:**
   ```ts
   export async function worktreeDiff(sessionId: string): Promise<{
     stat: string;      // git diff --stat output
     diff: string;      // git diff (full patch, truncated to 50KB)
     branch: string;
     baseBranch: string;
     filesChanged: number;
     insertions: number;
     deletions: number;
   }> { ... }
   ```
   Uses `execFileAsync("git", ["diff", "--stat", `${baseBranch}...${branch}`])` and `git diff` in the worktree directory.

2. **Add RPC method `worktree/diff`** in server/handlers/session.ts

3. **Add `ArkClient.worktreeDiff(id)`** in protocol/client.ts

4. **TUI:** When user presses `W`, show an overlay with the diff stat summary (files changed, +/- lines). Two buttons: "Merge Locally" and "Create PR" (see B1). Press Enter to confirm or Esc to cancel.

5. **Web UI:** Add a "Preview Changes" button on SessionDetail for sessions with worktrees. Show diff stat in a modal with syntax-highlighted patch view.

6. **CLI:** `ark worktree diff <session-id>` shows the diff stat. `ark worktree finish <id>` gains a `--preview` flag that shows diff before confirming.

**Files:** session-orchestration.ts, server/handlers/session.ts, protocol/client.ts, SessionsTab.tsx (TUI overlay), SessionDetail.tsx (Web), cli/index.ts

---

## Phase B: Workflow Completeness

### B1. PR Creation + GitHub Comment Sync

**Problem:** Conductor creates PRs (Cmd+Shift+P) and syncs review comments. Ark tracks `pr_url` but never creates a PR -- it relies on agents to do it.

**Architecture:** The `GhExecFn` injectable pattern from `pr-poller.ts` is directly reusable. `rollback.ts` shows the callback-injection pattern for testability. The `pr_url` DB field and index already exist.

**Implementation:**

1. **Add `createWorktreePR(sessionId, opts)` to session-orchestration.ts:**
   ```ts
   export async function createWorktreePR(sessionId: string, opts?: {
     title?: string;
     body?: string;
     base?: string;
     draft?: boolean;
   }): Promise<{ ok: boolean; pr_url?: string; message: string }> {
     // 1. Push branch: git push -u origin <branch>
     // 2. Create PR: gh pr create --title --body --base --head
     // 3. Store pr_url on session
     // 4. Log pr_created event
   }
   ```
   Use the `GhExecFn` pattern for testability.

2. **Add RPC method `worktree/create-pr`** in server/handlers/session.ts

3. **Add `ArkClient.worktreeCreatePR(id, opts)`** in protocol/client.ts

4. **Integrate with diff preview (A3):** The TUI overlay from A3 gets a "Create PR" button that calls this. Auto-generates title from session summary and body from diff stat.

5. **Enhance existing PR comment sync:** The `github-pr.ts` webhook handler already receives review comments and steers agents. Add a new endpoint `POST /hooks/github/pr-review` to conductor.ts that calls `formatReviewPrompt()` and delivers via channel. This path already works -- just needs to be documented and tested end-to-end.

6. **CLI:** `ark worktree finish <id> --pr` creates a PR instead of merging locally. `ark worktree finish <id> --pr --draft` for draft PRs.

7. **Web UI:** Add "Create PR" option in the finish worktree flow.

**Files:** session-orchestration.ts, server/handlers/session.ts, protocol/client.ts, SessionsTab.tsx, SessionDetail.tsx (Web), cli/index.ts, github-pr.ts (existing webhook)

---

### B2. Multi-Model Executor (Codex / OpenAI)

**Problem:** Conductor supports Codex alongside Claude Code. Ark is Claude-only.

**Architecture:** The `Executor` interface (`executor.ts`) is model-agnostic with 5 methods. The `runtime` field on `AgentDefinition` selects the executor. The friction points: `LaunchOpts.claudeArgs` is built unconditionally in dispatch, and the hook status system only works with Claude Code.

**Implementation:**

1. **Create `packages/core/executors/codex.ts`:**
   ```ts
   export const codexExecutor: Executor = {
     name: "codex",
     async launch(opts: LaunchOpts): Promise<LaunchResult> {
       // 1. Create worktree (reuse setupSessionWorktree)
       // 2. Build codex CLI args from agent.model, agent.system_prompt, agent.tools
       // 3. Write launcher script that runs: codex --model <model> --prompt <task>
       // 4. Launch in tmux session
       // 5. Return handle = tmux session name
     },
     async kill(handle) { await tmux.killSessionAsync(handle); },
     async status(handle) { return { alive: await tmux.sessionExistsAsync(handle) }; },
     async send(handle, msg) { await tmux.sendTextAsync(handle, msg); },
     async capture(handle, lines) { return await tmux.capturePaneAsync(handle, { lines }); },
   };
   ```

2. **Register in app.ts boot step 5b:**
   ```ts
   registerExecutor(codexExecutor);
   ```

3. **Create agent YAML:**
   ```yaml
   # agents/codex-worker.yaml
   name: codex-worker
   description: OpenAI Codex coding agent
   runtime: codex
   model: o4-mini
   max_turns: 200
   system_prompt: |
     Working on {repo}. Task: {summary}.
   permission_mode: bypassPermissions
   ```

4. **Clean up dispatch (session-orchestration.ts:244):** Move `buildClaudeArgs()` call inside the claude-code executor's `launch()` instead of calling it unconditionally. The claude-code executor already builds args internally -- the external call is redundant.

5. **Add status polling for non-Claude executors:** Create a `StatusPoller` that periodically calls `executor.status()` and updates session status when the process exits. Register it in `dispatch()` when the runtime is not `"claude-code"`:
   ```ts
   if (runtime !== "claude-code") {
     startStatusPoller(session.id, handle, executor);
   }
   ```

6. **Environment variable for Codex auth:** Agent YAML `env` field already supports arbitrary env vars. Users set `OPENAI_API_KEY` in agent YAML or `~/.ark/config.yaml`.

**Files:** executors/codex.ts (new), executor.ts (unchanged), agent.ts (unchanged), app.ts (register), session-orchestration.ts (cleanup + status poller), agents/codex-worker.yaml (new)

**Risk:** Codex CLI API surface may differ from Claude Code. The executor abstraction handles this -- each executor is self-contained. The main unknown is Codex's CLI arg format and how it handles task input.

---

## Phase C: Verification Gates

### C1. Verification Gates (Todos + Verify Scripts)

**Problem:** Agents can claim completion without proof. Conductor blocks merges on unresolved todos. We go further: an agent can only complete a stage when (1) all todos are resolved AND (2) verification scripts pass. Defined in flow YAML, enforced automatically.

**Design:** Verification is a first-class concept in the flow system, not a manual button. The `verify` field on a flow stage defines scripts that must pass before the stage can complete. Todos are user-added checklists that also block completion.

**Implementation:**

1. **Add `verify` field to flow stage YAML:**
   ```yaml
   # flows/definitions/verified.yaml
   name: verified
   stages:
     - name: implement
       agent: implementer
       gate: auto
       verify:
         - "npm test"
         - "npm run lint"
     - name: review
       agent: reviewer
       gate: manual
   ```

   Also support repo-level defaults in `.ark/config.yaml`:
   ```yaml
   verify:
     - "npm test"
   ```

2. **Add `todos` table to the DB:**
   ```sql
   CREATE TABLE IF NOT EXISTS todos (
     id INTEGER PRIMARY KEY,
     session_id TEXT NOT NULL,
     content TEXT NOT NULL,
     done INTEGER DEFAULT 0,
     created_at TEXT NOT NULL
   );
   ```

3. **Add `TodoRepository`** in repositories/ with `add`, `list`, `toggle`, `delete`, `allDone`.

4. **Add `runVerification(sessionId)` to session-orchestration.ts:**
   ```ts
   export async function runVerification(sessionId: string): Promise<{
     ok: boolean;
     results: Array<{ script: string; passed: boolean; output: string }>;
     todosResolved: boolean;
   }> {
     const session = getApp().sessions.get(sessionId);
     const stage = flow.getStageDefinition(session.flow, session.stage);
     const repoConfig = loadRepoConfig(session.workdir);
     const scripts = stage?.verify ?? repoConfig?.verify ?? [];
     const workdir = session.workdir;

     // Check todos
     const todosOk = getApp().todos.allDone(sessionId);

     // Run each verify script in the worktree
     const results = [];
     for (const script of scripts) {
       try {
         const { stdout } = await execFileAsync("bash", ["-c", script], { cwd: workdir, timeout: 60_000 });
         results.push({ script, passed: true, output: stdout });
       } catch (err) {
         results.push({ script, passed: false, output: err.stderr || err.message });
       }
     }

     const allPassed = results.every(r => r.passed);
     return { ok: allPassed && todosOk, results, todosResolved: todosOk };
   }
   ```

5. **Enforce in `complete()` and `finishWorktree()`:**
   ```ts
   // In complete():
   const verify = await runVerification(sessionId);
   if (!verify.ok) {
     return { ok: false, message: formatVerifyFailures(verify) };
   }

   // In finishWorktree():
   const verify = await runVerification(sessionId);
   if (!verify.ok) {
     return { ok: false, message: formatVerifyFailures(verify) };
   }
   ```

6. **Agent-side enforcement:** When an agent calls `report(type="completed")` via the channel, the conductor runs verification before accepting the completion. If verification fails, the conductor steers the agent with the failure output:
   ```
   Verification failed. Fix these before completing:
   - npm test: FAIL (exit code 1)
     <test output>
   - Unresolved todos: "Write migration docs"
   ```
   This creates a natural retry loop where the agent keeps working until verification passes.

7. **Add `--force` flag** to bypass verification for manual overrides:
   `ark session complete <id> --force`, `ark worktree finish <id> --force`

8. **RPC methods:** `verify/run` (run verification now), `todo/list`, `todo/add`, `todo/toggle`, `todo/delete`

9. **TUI:**
   - Show todos in SessionDetail right panel with checkboxes
   - `T` to add todo, `x` to toggle done
   - Show verification status (green/red) next to stage name
   - `V` to manually trigger verification run

10. **Web UI:** Todo checklist + verification status in SessionDetail. "Run Verification" button.

11. **CLI:**
    - `ark session verify <id>` -- run verification and show results
    - `ark session todo add <id> "Write tests"`
    - `ark session todo list <id>`
    - `ark session todo done <id> <todo-id>`
    - `ark session complete <id> --force` -- skip verification

**Files:** flow.ts (add verify field to StageDefinition), types/flow.ts, repositories/todo.ts (new), repositories/schema.ts, session-orchestration.ts (runVerification, enforce in complete/finish), conductor.ts (enforce on agent report), repo-config.ts (verify field), server/handlers/ (new verify + todo handlers), protocol/client.ts, TUI SessionDetail, Web SessionDetail.tsx, cli/index.ts

---

## Phase D: Polish

### D1. Session Archive/Restore

**Problem:** Conductor archives completed workspaces preserving chat history for later restoration. Ark has soft-delete (90s TTL).

**Implementation:**

1. **Add `archived` status** to session statuses. Archived sessions are hidden from default list but preserved indefinitely.

2. **`archive(sessionId)`:** Sets `status: "archived"`, preserves all data.

3. **`restore(sessionId)`:** Sets `status: "stopped"`, session reappears in list.

4. **List filter:** `listSessions({ status: "archived" })` to find archived sessions.

5. **TUI/Web/CLI:** `ark session archive <id>`, `ark session restore <id>`. TUI: show in a separate "Archived" filter.

**Files:** types/session.ts (add "archived" to SessionStatus), session-orchestration.ts, server/handlers, protocol/client.ts, TUI, Web, CLI

---

### D2. Diff Re-Review Flagging

**Problem:** Conductor flags previously-reviewed files that were modified after review.

**Implementation:**

1. **Track reviewed files per session:** When a user views the diff (A3), store the file list + content hash in `session.config.reviewed_files`.

2. **On subsequent diff view,** compare current file hashes against stored ones. Flag files where the hash changed (modified since last review).

3. **TUI/Web:** Show a yellow indicator next to modified-since-review files in the diff overlay.

**Files:** session-orchestration.ts (worktreeDiff enhancement), SessionsTab.tsx (diff overlay), SessionDetail.tsx (Web)

---

## Dependency Graph

```
A1 (interrupt)           -- independent
A2 (diff preview)        -- independent
B1 (PR creation)         -- depends on A2 (diff overlay is the entry point)
B2 (multi-model)         -- independent
C1 (verification gates)  -- independent
D1 (archive)             -- independent
D2 (re-review)           -- depends on A2 (diff tracking)
```

Phase A items are independent and can be parallelized.
B1 depends on A2 for the TUI overlay.
C1 is independent and high-value (agent quality enforcement).

---

## Estimated Execution Order

| Session | Items | Parallelizable? |
|---------|-------|-----------------|
| 1 | A1 (interrupt) + A2 (diff preview) | Yes -- different modules |
| 2 | B1 (PR creation) + C1 (verification gates) | Yes -- B1 uses A2 overlay; C1 independent |
| 3 | B2 (multi-model executor) | Independent, highest effort |
| 4 | D1 (archive) + D2 (re-review) | Yes -- both independent |

---

## What This Closes

After all phases:

| Gap | Status |
|-----|--------|
| Pause agent | **Closed** (A1) |
| Diff viewer | **Closed** (A2) |
| PR creation + GitHub sync | **Closed** (B1) |
| Multi-model (Codex) | **Closed** (B2) |
| Verification + run scripts + todo gates | **Closed** (C1) -- combined and improved |
| Archive/restore | **Closed** (D1) |
| Diff re-review | **Closed** (D2) |

Ark retains all existing advantages (multi-compute, flows, CI mode, guardrails, FTS5 search, skills/recipes, memory, OTLP, auto-rollback, web UI, cross-platform) while exceeding Conductor on quality enforcement -- Conductor has manual todo checklists, Ark has automatic verification gates that block agent completion until scripts pass.
