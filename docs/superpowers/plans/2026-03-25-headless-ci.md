# Headless CI Mode (ark exec) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `ark exec` command that runs a session non-interactively — creates, dispatches, waits for completion, and exits with an appropriate code. Designed for CI/CD pipelines.

**Architecture:** `ark exec` creates a session, dispatches it, then polls session status until terminal state (completed/failed). Output modes: `text` (human log) and `json` (structured). Exit codes: 0=success, 1=failure, 2=timeout. The conductor handles hooks — `ark exec` just polls and exits.

**Tech Stack:** Existing CLI (Commander), existing session/dispatch/conductor

---

## Usage

```bash
ark exec --repo . --summary "Fix the auth bug"
ark exec --flow quick --repo /path --ticket PROJ-123 --compute ec2-dev
ark exec --repo . --summary "Run tests" --output json
ark exec --repo . --summary "Review code" --autonomy read-only
ark exec --repo . --summary "Deploy" --timeout 600
```

**Exit codes:** 0=completed, 1=failed, 2=timeout, 3=interrupted

---

## File Structure

| File | Change |
|------|--------|
| `packages/core/session.ts` | **Modify:** Add `waitForCompletion()` |
| `packages/core/index.ts` | **Modify:** Re-export |
| `packages/cli/exec.ts` | **Create:** exec command implementation |
| `packages/cli/index.ts` | **Modify:** Register exec command |
| `packages/core/__tests__/e2e-exec.test.ts` | **Create:** Tests |

---

### Task 1: waitForCompletion + exec command + tests

This is a single focused deliverable — the polling function, the CLI command, and tests.

**waitForCompletion in session.ts:**

```ts
export async function waitForCompletion(
  sessionId: string,
  opts?: { timeoutMs?: number; pollMs?: number; onStatus?: (status: string) => void },
): Promise<{ session: store.Session; timedOut: boolean }> {
  const timeout = opts?.timeoutMs ?? 0;
  const pollMs = opts?.pollMs ?? 3000;
  const start = Date.now();
  while (true) {
    const session = store.getSession(sessionId);
    if (!session) return { session: null as any, timedOut: false };
    if (["completed", "failed", "stopped"].includes(session.status)) return { session, timedOut: false };
    opts?.onStatus?.(session.status);
    if (timeout > 0 && Date.now() - start > timeout) return { session, timedOut: true };
    await new Promise(r => setTimeout(r, pollMs));
  }
}
```

**exec.ts:** Creates session, dispatches, waits, outputs result (text or json), exits with code.

**CLI registration:** `ark exec` with --repo, --summary, --ticket, --flow, --compute, --group, --autonomy, --output, --timeout. Boots AppContext WITH conductor (unlike normal CLI).

**Tests:** waitForCompletion returns immediately for terminal states, times out, calls onStatus. Session creation with correct options. JSON output produces valid JSON.

- [ ] **Step 1: Add waitForCompletion to session.ts + re-export**
- [ ] **Step 2: Write tests for waitForCompletion**
- [ ] **Step 3: Create exec.ts**
- [ ] **Step 4: Register in cli/index.ts**
- [ ] **Step 5: Write E2E tests**
- [ ] **Step 6: Run all tests**
- [ ] **Step 7: Commit and push**

```bash
git commit -m "feat: ark exec — headless CI mode for non-interactive session running"
git commit -m "test: E2E tests for ark exec"
git push
```
