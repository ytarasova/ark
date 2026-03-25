# PR Monitoring + Comment Resolution — Plan

## Overview

Watch GitHub PRs for review comments. When comments arrive, auto-dispatch an agent session to address them. GitHub-first, Bitbucket later.

## How it works

```
Developer creates PR → Reviewer leaves comments → GitHub webhook fires
  → Ark conductor receives webhook
    → Creates a new session (or resumes existing) bound to the PR
      → Agent reads the PR diff + comments via gh CLI / GitHub MCP
        → Agent makes changes, pushes, replies to comments
          → PR updated, reviewer notified
```

## Components

### 1. GitHub webhook receiver

New endpoint in conductor: `POST /api/webhook/github`

Accepts GitHub webhook events:
- `pull_request_review` — new review submitted
- `pull_request_review_comment` — individual line comment
- `issue_comment` — PR-level comment (not line-specific)

Validates HMAC signature (`X-Hub-Signature-256`) against a shared secret.

### 2. PR session binding

A PR maps to an Ark session. When a webhook fires:
1. Check if a session already exists for this PR (lookup by `pr_url` or `pr_id` in sessions table)
2. If exists and running: send a steer message via channel ("New review comments — address them")
3. If exists and stopped/completed: resume with `--resume` to continue the conversation
4. If doesn't exist: create a new session with:
   - `summary`: PR title
   - `repo`: from webhook payload
   - `flow`: configurable (default: `bare`)
   - `pr_url` / `pr_id`: from webhook
   - Task prompt includes the review comments

### 3. Comment extraction

Parse the webhook payload to extract:
- Reviewer name
- Comment body
- File path + line number (for line comments)
- Review state (approved / changes_requested / commented)

Format into a structured task prompt:

```
PR #42: "Add auth middleware" has new review comments.

## Review by @reviewer (changes_requested)

### src/auth.ts:42
> This should validate the JWT expiry

### src/auth.ts:78
> Missing error handling for expired tokens

Address each comment, push changes, and reply to confirm.
```

### 4. Agent tools

The agent needs:
- `gh pr view` — read PR details
- `gh pr diff` — read the diff
- `gh api` — read/write comments, push reviews
- Standard file tools (Read, Write, Edit) — make changes
- `git push` — push the fix

These are already available via Claude Code's built-in tools + the `gh` CLI.

### 5. Configuration

In `.ark.yaml`:

```yaml
pr_monitoring:
  enabled: true
  flow: bare
  compute: local
  agent: implementer
  auto_dispatch: true  # false = create session but don't dispatch (human triggers)
  webhook_secret: ${ARK_GITHUB_WEBHOOK_SECRET}
```

Or via CLI:

```bash
ark pr watch --repo owner/repo --webhook-secret $SECRET
ark pr list   # list monitored PRs
ark pr status # show PR sessions
```

### 6. Webhook setup

User registers a GitHub webhook on their repo:
- URL: `https://<conductor-host>:19100/api/webhook/github`
- Events: Pull request reviews, Pull request review comments, Issue comments
- Secret: shared HMAC secret

For local development: use `gh webhook forward` or ngrok.

## File Structure

| File | Change |
|------|--------|
| `packages/core/pr-monitor.ts` | **Create:** Webhook handler, comment parser, session binding |
| `packages/core/conductor.ts` | **Modify:** Add `/api/webhook/github` endpoint |
| `packages/cli/index.ts` | **Modify:** Add `ark pr` commands |
| `packages/core/store.ts` | **Modify:** Add index on `pr_url` for fast lookup |
| `packages/core/__tests__/pr-monitor.test.ts` | **Create:** Tests |
| `packages/core/__tests__/e2e-pr-monitor.test.ts` | **Create:** E2E tests |

## Phases

### Phase 1: Core (3d)
- Webhook receiver with HMAC validation
- Comment extraction from webhook payload
- Session creation/resume for PRs
- Task prompt generation
- CLI: `ark pr watch`, `ark pr list`

### Phase 2: Polish (future)
- Bitbucket support (different webhook format)
- GitLab support
- Auto-reply to comments when agent pushes fix
- PR status checks integration
- Draft PR → ready for review transition triggers

## Security

- HMAC signature validation on every webhook
- Webhook secret stored in env var, never in config files
- Agent runs with whatever autonomy the flow specifies
- No auto-merge — agent addresses comments, human merges

## Effort

~3 days for Phase 1 (GitHub only).
