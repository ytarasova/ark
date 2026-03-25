# Review Gate + GitHub Webhook — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `review` gate type to flows that blocks until a GitHub PR is approved. Review comments auto-steer the agent to fix issues. Approval opens the gate and advances the flow.

**Architecture:** A new `gate: review` in the flow engine blocks like `manual` but listens for GitHub webhook events. The conductor gets a `/api/webhook/github` endpoint that validates HMAC, parses review events, and either steers the agent (changes_requested) or opens the gate (approved). Sessions are bound to PRs via the existing `pr_url`/`pr_id` fields.

**Tech Stack:** Existing conductor HTTP server, existing channel steer mechanism, existing flow gate system, GitHub webhook HMAC validation

---

## File Structure

| File | Change |
|------|--------|
| `packages/core/flow.ts` | **Modify:** Add `review` gate type to `evaluateGate` |
| `packages/core/github-webhook.ts` | **Create:** Webhook handler — HMAC validation, comment extraction, session binding |
| `packages/core/conductor.ts` | **Modify:** Add `/api/webhook/github` endpoint, wire to handler |
| `packages/core/session.ts` | **Modify:** Add `approveReviewGate()` — opens review gate for a session |
| `packages/core/store.ts` | **Modify:** Add index on `pr_url` for fast PR→session lookup |
| `packages/core/index.ts` | **Modify:** Re-exports |
| `packages/cli/index.ts` | **Modify:** Add `ark pr` commands |
| `packages/core/__tests__/github-webhook.test.ts` | **Create:** Tests |
| `packages/core/__tests__/e2e-review-gate.test.ts` | **Create:** E2E tests |

---

### Task 1: Add `review` gate type + `approveReviewGate`

**Files:**
- Modify: `packages/core/flow.ts`
- Modify: `packages/core/session.ts`
- Modify: `packages/core/store.ts`
- Modify: `packages/core/index.ts`

In `flow.ts:evaluateGate`, add the `review` case:

```ts
case "review":
  return { canProceed: false, reason: "review gate: awaiting PR approval" };
```

Like `manual`, it always blocks. The conductor opens it via `session.advance(id, true)` (force=true) when approval webhook arrives.

In `session.ts`, add:

```ts
/** Open a review gate — called when PR is approved via webhook. */
export function approveReviewGate(sessionId: string): { ok: boolean; message: string } {
  const s = store.getSession(sessionId);
  if (!s) return { ok: false, message: "Session not found" };

  store.logEvent(sessionId, "review_approved", {
    stage: s.stage, actor: "github",
  });

  // Force-advance past the review gate
  return advance(sessionId, true);
}
```

In `store.ts`, add index:

```sql
CREATE INDEX IF NOT EXISTS idx_sessions_pr ON sessions(pr_url);
```

Re-export `approveReviewGate` from `index.ts`.

Tests:
- `evaluateGate` with `review` returns `canProceed: false`
- `approveReviewGate` advances a session past a review stage
- Session with no review stage — approveReviewGate returns error

- [ ] **Step 1: Add review gate + approveReviewGate + index**
- [ ] **Step 2: Write tests**
- [ ] **Step 3: Run tests**
- [ ] **Step 4: Commit**

```bash
git commit -m "feat: review gate type — blocks flow until PR approved"
```

---

### Task 2: GitHub webhook handler

**Files:**
- Create: `packages/core/github-webhook.ts`
- Create: `packages/core/__tests__/github-webhook.test.ts`

```ts
// packages/core/github-webhook.ts

import { createHmac } from "crypto";
import * as store from "./store.js";
import * as session from "./session.js";
import { deliverTask } from "./claude.js";

export interface ReviewComment {
  author: string;
  body: string;
  path?: string;
  line?: number;
}

export interface WebhookResult {
  action: "steer" | "approve" | "ignore";
  sessionId?: string;
  message?: string;
}

/** Validate GitHub webhook HMAC-SHA256 signature. */
export function validateSignature(payload: string, signature: string, secret: string): boolean {
  const expected = "sha256=" + createHmac("sha256", secret).update(payload).digest("hex");
  return signature === expected;
}

/** Extract review comments from a GitHub webhook payload. */
export function extractComments(payload: any): ReviewComment[] {
  const comments: ReviewComment[] = [];

  if (payload.review?.body) {
    comments.push({
      author: payload.review?.user?.login ?? "unknown",
      body: payload.review.body,
    });
  }

  if (payload.comment) {
    comments.push({
      author: payload.comment?.user?.login ?? "unknown",
      body: payload.comment.body,
      path: payload.comment.path,
      line: payload.comment.line ?? payload.comment.original_line,
    });
  }

  return comments;
}

/** Format review comments into an agent task prompt. */
export function formatReviewPrompt(prTitle: string, prNumber: number, comments: ReviewComment[], state?: string): string {
  const parts: string[] = [];
  parts.push(`PR #${prNumber}: "${prTitle}" has new review feedback.`);
  if (state) parts.push(`\nReview state: ${state}`);
  parts.push("");

  for (const c of comments) {
    if (c.path && c.line) {
      parts.push(`### ${c.path}:${c.line}`);
    }
    parts.push(`**@${c.author}:** ${c.body}`);
    parts.push("");
  }

  parts.push("Address each comment, push changes, and reply to confirm resolution.");
  return parts.join("\n");
}

/** Find the Ark session bound to a PR. */
export function findSessionByPR(prUrl: string): store.Session | null {
  const db = store.getDb();
  const row = db.prepare("SELECT * FROM sessions WHERE pr_url = ? ORDER BY created_at DESC LIMIT 1").get(prUrl) as any;
  if (!row) return null;
  return { ...row, ticket: row.jira_key, summary: row.jira_summary, flow: row.pipeline, config: JSON.parse(row.config ?? "{}") };
}

/** Handle a GitHub webhook event. Returns the action taken. */
export async function handleGitHubWebhook(event: string, payload: any): Promise<WebhookResult> {
  // Only handle review events
  if (event === "pull_request_review") {
    const prUrl = payload.pull_request?.html_url;
    if (!prUrl) return { action: "ignore", message: "No PR URL" };

    const s = findSessionByPR(prUrl);
    if (!s) return { action: "ignore", message: `No session for PR ${prUrl}` };

    const state = payload.review?.state; // "approved", "changes_requested", "commented"
    const comments = extractComments(payload);

    if (state === "approved") {
      // Open the review gate
      const result = session.approveReviewGate(s.id);
      store.logEvent(s.id, "pr_approved", {
        actor: "github",
        data: { pr_url: prUrl, reviewer: payload.review?.user?.login },
      });
      return { action: "approve", sessionId: s.id, message: result.message };
    }

    if (state === "changes_requested" && comments.length > 0) {
      // Steer the agent with the review comments
      const prompt = formatReviewPrompt(
        payload.pull_request.title,
        payload.pull_request.number,
        comments,
        state,
      );

      // If session is running, steer via channel
      if (s.session_id && s.status === "running") {
        const channelPort = store.sessionChannelPort(s.id);
        try {
          await fetch(`http://localhost:${channelPort}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ type: "steer", sessionId: s.id, message: prompt, from: "github" }),
          });
        } catch {}
      }

      // If session is waiting/ready, re-dispatch with the review task
      if (["ready", "waiting", "stopped", "completed"].includes(s.status)) {
        store.updateSession(s.id, { status: "ready" });
        await session.dispatch(s.id);
      }

      store.logEvent(s.id, "pr_changes_requested", {
        actor: "github",
        data: { pr_url: prUrl, reviewer: payload.review?.user?.login, comments: comments.length },
      });

      return { action: "steer", sessionId: s.id, message: `Steered agent with ${comments.length} comment(s)` };
    }
  }

  // Handle individual line comments
  if (event === "pull_request_review_comment") {
    const prUrl = payload.pull_request?.html_url;
    if (!prUrl) return { action: "ignore" };

    const s = findSessionByPR(prUrl);
    if (!s) return { action: "ignore", message: `No session for PR ${prUrl}` };

    const comments = extractComments(payload);
    if (comments.length === 0) return { action: "ignore" };

    const prompt = formatReviewPrompt(
      payload.pull_request.title,
      payload.pull_request.number,
      comments,
    );

    // Steer running session
    if (s.session_id && s.status === "running") {
      const channelPort = store.sessionChannelPort(s.id);
      try {
        await fetch(`http://localhost:${channelPort}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "steer", sessionId: s.id, message: prompt, from: "github" }),
        });
      } catch {}
    }

    return { action: "steer", sessionId: s.id };
  }

  return { action: "ignore" };
}
```

Tests:
- `validateSignature` with correct secret returns true
- `validateSignature` with wrong secret returns false
- `extractComments` from review payload
- `extractComments` from line comment payload
- `formatReviewPrompt` produces readable prompt
- `findSessionByPR` returns session by pr_url
- `findSessionByPR` returns null for unknown PR
- `handleGitHubWebhook` with "approved" calls approveReviewGate
- `handleGitHubWebhook` with "changes_requested" steers agent
- `handleGitHubWebhook` ignores unknown events

- [ ] **Step 1: Create github-webhook.ts**
- [ ] **Step 2: Write tests**
- [ ] **Step 3: Run tests**
- [ ] **Step 4: Commit**

```bash
git commit -m "feat: GitHub webhook handler — HMAC validation, comment extraction, session binding"
```

---

### Task 3: Wire into conductor + CLI

**Files:**
- Modify: `packages/core/conductor.ts`
- Modify: `packages/cli/index.ts`

Add webhook endpoint to conductor:

```ts
// In startConductor fetch handler, before the 404:

if (req.method === "POST" && path === "/api/webhook/github") {
  const secret = process.env.ARK_GITHUB_WEBHOOK_SECRET;
  if (!secret) return Response.json({ error: "webhook secret not configured" }, { status: 500 });

  const body = await req.text();
  const sig = req.headers.get("x-hub-signature-256") ?? "";

  if (!validateSignature(body, sig, secret)) {
    return Response.json({ error: "invalid signature" }, { status: 401 });
  }

  const event = req.headers.get("x-github-event") ?? "";
  const payload = JSON.parse(body);
  const result = await handleGitHubWebhook(event, payload);

  return Response.json(result);
}
```

Add CLI commands:

```bash
ark pr list              # list sessions with pr_url set
ark pr status <pr-url>   # show session bound to a PR
```

- [ ] **Step 1: Add webhook endpoint to conductor**
- [ ] **Step 2: Add CLI commands**
- [ ] **Step 3: Verify: `bun run packages/cli/index.ts pr --help`**
- [ ] **Step 4: Commit**

```bash
git commit -m "feat: conductor /api/webhook/github endpoint + ark pr CLI"
```

---

### Task 4: E2E tests + push

**Files:**
- Create: `packages/core/__tests__/e2e-review-gate.test.ts`

Full flow test:
1. Create a session with a flow that has `gate: review`
2. Dispatch — session runs, agent completes the implement stage
3. Agent completes → advance → hits review gate → blocks
4. Simulate GitHub webhook with `changes_requested` → verify steer
5. Simulate GitHub webhook with `approved` → verify gate opens, flow advances
6. Verify events logged correctly

Also test:
- HMAC validation rejects bad signature
- Webhook for unknown PR returns ignore
- Multiple comments formatted correctly

- [ ] **Step 1: Write E2E tests**
- [ ] **Step 2: Run all tests**
- [ ] **Step 3: Commit and push**

```bash
git commit -m "test: E2E tests for review gate + GitHub webhook"
git push
```
