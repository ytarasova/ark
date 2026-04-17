# Plan: Update User Guide

## Summary

The user guide (`docs/guide.md`) was last synced at commit `435fdf0` and is missing several CLI commands, session subcommands, compute subcommands, worktree subcommands, and top-level utility commands that exist in the codebase. It also contains a phantom `ark worktree merge` command that doesn't exist and has inaccurate auth CLI syntax. This plan covers a comprehensive audit and update to bring the guide in line with the actual CLI surface.

## Files to modify/create

| File | Change |
|------|--------|
| `docs/guide.md` | Add missing commands, fix inaccuracies, update CLI module count |

## Implementation steps

### 1. Add missing session subcommands to section 2

The session lifecycle table (lines 77-91) is missing these subcommands that exist in `packages/cli/commands/session.ts`:

| Command | Description |
|---------|-------------|
| `ark session show <id>` | Display session details. |
| `ark session attach <id>` | Attach to the session's tmux window. |
| `ark session output <id>` | Print latest agent output. |
| `ark session send <id> <text>` | Send a message to the running agent. |
| `ark session undelete <id>` | Restore a soft-deleted session. |
| `ark session spawn <id>` | Spawn a child session from a parent. |
| `ark session spawn-subagent <id>` | Spawn a subagent child session. |
| `ark session group <name>` | List sessions in a group. |
| `ark session export <id>` | Export a session to a portable format. |
| `ark session import <path>` | Import a session from a file. |
| `ark session restore <id>` | Restore an archived session (guide incorrectly shows `archive --restore`). |

Add these to the lifecycle operations table. Also fix `ark session archive <id> --restore` (line 155) to `ark session restore <id>`.

### 2. Add `ark exec` and `ark try` commands (new subsection)

Add a new section (or subsection under Sessions) documenting these two top-level commands from `packages/cli/commands/exec-try.ts`:

- **`ark exec`** (line 20-52 of exec-try.ts): CI/CD-oriented headless session. Starts a conductor-backed session, runs to completion, exits with the session's result code. Options: `--repo`, `--summary`, `--ticket`, `--flow`, `--compute`, `--group`, `--autonomy`, `--output`, `--timeout`.
- **`ark try <task>`** (line 54-95): One-shot sandboxed session that auto-deletes after the user detaches. Option: `--image` (Docker image, default `ubuntu:22.04`).

### 3. Add missing misc top-level commands

Add to the CLI section (section 15) or as a new "Utilities" subsection. These are registered in `packages/cli/commands/misc.ts`:

| Command | Description |
|---------|-------------|
| `ark pr list` | List sessions bound to PRs. |
| `ark pr status <pr-url>` | Show session bound to a PR. |
| `ark watch` | Poll for new issues/PRs and auto-dispatch sessions. |
| `ark claude list` | List active Claude Code sessions. |
| `ark doctor` | Health check (bun, tmux, git, gh, API keys). |
| `ark config` | Show/edit `~/.ark/config.yaml`. |
| `ark init` | Initialize `.ark/` in the current repo. |
| `ark web` | Already documented -- no change needed. |
| `ark openapi` | Generate OpenAPI spec from the JSON-RPC surface. |
| `ark mcp-proxy` | Run an MCP-to-JSON-RPC proxy. |
| `ark acp` | Agent Communication Protocol server. |
| `ark repo-map` | Generate a repo map for context injection. |

### 4. Fix worktree commands (section 13)

- **Remove** phantom `ark worktree merge <sessionId>` (line 790) -- this command does not exist in `packages/cli/commands/worktree.ts`.
- **Add** `ark worktree list` -- list all active worktrees.
- **Add** `ark worktree cleanup` -- remove stale/orphaned worktrees.

### 5. Add missing compute subcommands (section 7)

The compute CLI section (lines 469-478) is minimal. Add these from `packages/cli/commands/compute.ts`:

| Command | Description |
|---------|-------------|
| `ark compute provision <id>` | Provision a compute resource (EC2, etc). |
| `ark compute destroy <id>` | Tear down the underlying infrastructure. |
| `ark compute update <id>` | Update compute configuration. |
| `ark compute status <id>` | Detailed status check with health probes. |
| `ark compute sync <id>` | Sync repo files to a remote compute. |
| `ark compute metrics <id>` | Show system metrics (CPU, memory, disk). |
| `ark compute default <name>` | Set the default compute target. |
| `ark compute ssh <id>` | SSH into a remote compute. |
| `ark compute pool create/list/delete` | Manage compute pools. |

### 6. Fix auth CLI syntax (section 12)

Guide shows `ark auth key create/list/revoke/rotate` but actual commands are:
- `ark auth setup` -- interactive API key setup
- `ark auth create-key`
- `ark auth list-keys`
- `ark auth revoke-key <keyId>`
- `ark auth rotate-key <keyId>`

Update the code examples on lines 725-729.

### 7. Add missing search commands (section 14)

Add `ark search-all` -- searches sessions, events, messages, and transcripts in one pass (registered in `packages/cli/commands/search.ts`).

### 8. Update CLI module count and summary (section 15)

- Update "Twenty-four command modules" to "Twenty-five command modules" (adding exec-try).
- Update the enumeration to replace "server-daemon" with "exec-try" (server-daemon is a sub-module of server, not a standalone register function).
- Update the closing paragraph similarly.

### 9. Add conductor learnings commands (section not currently covered)

The conductor module (`packages/cli/commands/conductor.ts`) has:
- `ark conductor learnings` -- list accumulated learnings
- `ark conductor learn <text>` -- add a learning
- `ark conductor bridge` -- start a bridge for remote communication
- `ark conductor notify` -- send a notification to running sessions

These are not documented in any section. Add a brief mention under section 15 or a dedicated subsection.

### 10. Add eval commands (not currently covered)

The eval module (`packages/cli/commands/eval.ts`) has:
- `ark eval stats` -- show evaluation statistics
- `ark eval drift` -- detect agent behavior drift
- `ark eval list` -- list evaluations

Add a brief subsection or mention in section 15.

## Testing strategy

- **Manual review**: After editing, read through the entire guide and verify every command example against the corresponding `packages/cli/commands/*.ts` file.
- **Spot-check CLI**: Run `ark --help`, `ark session --help`, `ark compute --help`, `ark worktree --help` to verify command names match the documented ones.
- **Lint**: Run `make format` and `make lint` to ensure no formatting issues.
- **No code changes**: This is a docs-only update, so no tests need to be added or modified.

## Risk assessment

- **Low risk**: Documentation-only change, no code affected.
- **Stale commands**: Some commands may have options not fully documented. The plan focuses on getting all commands listed rather than exhaustive option documentation.
- **Count accuracy**: CLI module count depends on how you count (register functions vs. top-level commands vs. subcommand groups). The plan counts register functions in `packages/cli/cli.ts`.

## Open questions

- **Depth vs. breadth**: Should every command option be documented (e.g., all 15+ `ark session start` flags), or is listing the command with a one-line description sufficient? Decision: list commands with descriptions; only document non-obvious options in examples.
- **Section restructuring**: The guide could benefit from a dedicated "CLI Reference" section that lists ALL commands, separate from the thematic sections. Decision: keep the thematic structure but add missing commands to their relevant sections, plus a "Utility Commands" subsection in section 15 for the misc top-level commands.
