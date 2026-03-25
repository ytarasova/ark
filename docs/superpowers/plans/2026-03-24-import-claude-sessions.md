# Import Claude Sessions — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Discover existing Claude Code sessions and create Ark sessions from them, binding the Ark session to the Claude session ID and repo for `--resume` support.

**Architecture:** A new `claude-sessions.ts` module scans `~/.claude/projects/` directories, parses JSONL transcript headers to extract session metadata (ID, project path, timestamp, first user message as summary, message count). CLI exposes `ark claude list` and `ark session import --claude-session <id>`. The import creates an Ark session with `claude_session_id` set so dispatch uses `--resume`.

**Tech Stack:** JSONL parsing, existing CLI (Commander), existing store

---

## File Structure

| File | Change |
|------|--------|
| `packages/core/claude-sessions.ts` | **Create:** `listClaudeSessions()`, `getClaudeSession()` — discover Claude sessions from disk |
| `packages/core/index.ts` | **Modify:** Re-export claude-sessions |
| `packages/core/__tests__/claude-sessions.test.ts` | **Create:** Tests |
| `packages/cli/index.ts` | **Modify:** Add `ark claude list` and `ark session import --claude-session` |

---

### Task 1: listClaudeSessions — discover Claude sessions from disk

**Files:**
- Create: `packages/core/claude-sessions.ts`
- Create: `packages/core/__tests__/claude-sessions.test.ts`
- Modify: `packages/core/index.ts`

- [ ] **Step 1: Write the test file**

```ts
/**
 * Tests for claude-sessions.ts — discover Claude Code sessions from disk.
 */

import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import {
  createTestContext, setContext, resetContext,
  type TestContext,
} from "../context.js";
import { listClaudeSessions, getClaudeSession, type ClaudeSession } from "../claude-sessions.js";

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

function writeClaudeSession(projectDir: string, sessionId: string, entries: Record<string, unknown>[]) {
  const dir = join(ctx.arkDir, "claude-projects", projectDir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${sessionId}.jsonl`),
    entries.map(e => JSON.stringify(e)).join("\n") + "\n"
  );
}

describe("listClaudeSessions", () => {
  it("returns empty array when no sessions exist", () => {
    const sessions = listClaudeSessions({ baseDir: join(ctx.arkDir, "claude-projects") });
    expect(sessions).toEqual([]);
  });

  it("discovers sessions from JSONL files", () => {
    writeClaudeSession("-Users-dev-myproject", "abc-123", [
      { type: "system", sessionId: "abc-123", timestamp: "2026-03-24T10:00:00Z" },
      { type: "user", message: { role: "user", content: [{ type: "text", text: "fix the auth bug" }] }, timestamp: "2026-03-24T10:00:01Z" },
      { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "I'll fix it" }] }, timestamp: "2026-03-24T10:00:02Z" },
    ]);

    const sessions = listClaudeSessions({ baseDir: join(ctx.arkDir, "claude-projects") });
    expect(sessions.length).toBe(1);
    expect(sessions[0].sessionId).toBe("abc-123");
    expect(sessions[0].summary).toContain("fix the auth bug");
    expect(sessions[0].project).toContain("myproject");
  });

  it("extracts project path from directory name", () => {
    writeClaudeSession("-Users-yana-Projects-ark", "sess-1", [
      { type: "system", sessionId: "sess-1", timestamp: "2026-03-24T10:00:00Z" },
    ]);

    const sessions = listClaudeSessions({ baseDir: join(ctx.arkDir, "claude-projects") });
    expect(sessions[0].project).toBe("/Users/yana/Projects/ark");
  });

  it("counts messages", () => {
    writeClaudeSession("-test", "sess-2", [
      { type: "system", sessionId: "sess-2", timestamp: "2026-03-24T10:00:00Z" },
      { type: "user", message: { role: "user", content: "hello" }, timestamp: "2026-03-24T10:00:01Z" },
      { type: "assistant", message: { role: "assistant", content: "hi" }, timestamp: "2026-03-24T10:00:02Z" },
      { type: "user", message: { role: "user", content: "more" }, timestamp: "2026-03-24T10:00:03Z" },
      { type: "assistant", message: { role: "assistant", content: "ok" }, timestamp: "2026-03-24T10:00:04Z" },
    ]);

    const sessions = listClaudeSessions({ baseDir: join(ctx.arkDir, "claude-projects") });
    expect(sessions[0].messageCount).toBe(4); // 2 user + 2 assistant
  });

  it("sorts by most recent first", () => {
    writeClaudeSession("-proj", "old", [
      { type: "system", sessionId: "old", timestamp: "2026-03-20T10:00:00Z" },
    ]);
    writeClaudeSession("-proj", "new", [
      { type: "system", sessionId: "new", timestamp: "2026-03-24T10:00:00Z" },
    ]);

    const sessions = listClaudeSessions({ baseDir: join(ctx.arkDir, "claude-projects") });
    expect(sessions[0].sessionId).toBe("new");
    expect(sessions[1].sessionId).toBe("old");
  });

  it("skips subagent directories", () => {
    writeClaudeSession("-proj", "main-sess", [
      { type: "system", sessionId: "main-sess", timestamp: "2026-03-24T10:00:00Z" },
    ]);
    // Subagent transcripts live in subdirs
    const subDir = join(ctx.arkDir, "claude-projects", "-proj", "main-sess", "subagents");
    mkdirSync(subDir, { recursive: true });
    writeFileSync(join(subDir, "agent-abc.jsonl"), JSON.stringify({ type: "system" }));

    const sessions = listClaudeSessions({ baseDir: join(ctx.arkDir, "claude-projects") });
    expect(sessions.length).toBe(1);
    expect(sessions[0].sessionId).toBe("main-sess");
  });

  it("respects limit", () => {
    for (let i = 0; i < 10; i++) {
      writeClaudeSession("-proj", `sess-${i}`, [
        { type: "system", sessionId: `sess-${i}`, timestamp: `2026-03-${String(10 + i).padStart(2, "0")}T10:00:00Z` },
      ]);
    }

    const sessions = listClaudeSessions({ baseDir: join(ctx.arkDir, "claude-projects"), limit: 5 });
    expect(sessions.length).toBe(5);
  });
});

describe("getClaudeSession", () => {
  it("returns session by ID", () => {
    writeClaudeSession("-proj", "target-id", [
      { type: "system", sessionId: "target-id", timestamp: "2026-03-24T10:00:00Z" },
      { type: "user", message: { role: "user", content: "do the thing" }, timestamp: "2026-03-24T10:00:01Z" },
    ]);

    const session = getClaudeSession("target-id", { baseDir: join(ctx.arkDir, "claude-projects") });
    expect(session).not.toBeNull();
    expect(session!.sessionId).toBe("target-id");
  });

  it("returns null for non-existent session", () => {
    const session = getClaudeSession("does-not-exist", { baseDir: join(ctx.arkDir, "claude-projects") });
    expect(session).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/core/__tests__/claude-sessions.test.ts`

- [ ] **Step 3: Implement claude-sessions.ts**

Create `packages/core/claude-sessions.ts`:

```ts
/**
 * Claude Code session discovery — scan ~/.claude/projects/ for transcripts.
 *
 * Claude stores sessions as JSONL files at:
 *   ~/.claude/projects/<encoded-path>/<session-uuid>.jsonl
 *
 * The encoded path replaces / with - and strips leading dots.
 * Subagent transcripts live in <session-uuid>/subagents/ — skip these.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { join, basename } from "path";
import { homedir } from "os";

export interface ClaudeSession {
  sessionId: string;
  project: string;        // decoded project path (e.g., /Users/yana/Projects/ark)
  projectDir: string;     // raw dir name (e.g., -Users-yana-Projects-ark)
  transcriptPath: string; // full path to JSONL file
  summary: string;        // first user message (truncated)
  messageCount: number;   // user + assistant messages
  timestamp: string;      // first entry timestamp
  lastActivity: string;   // last entry timestamp
}

export interface ListOpts {
  baseDir?: string;
  limit?: number;
  project?: string; // filter by project path substring
}

/**
 * Decode a Claude project directory name to a filesystem path.
 * "-Users-yana-Projects-ark" → "/Users/yana/Projects/ark"
 */
function decodeProjectDir(dirName: string): string {
  return dirName.replace(/^-/, "/").replace(/-/g, "/");
}

/**
 * Extract metadata from a Claude JSONL transcript without reading the full file.
 * Reads first ~20 lines for header info + summary, counts total messages.
 */
function parseTranscriptMeta(filePath: string): Omit<ClaudeSession, "project" | "projectDir" | "transcriptPath"> | null {
  let content: string;
  try { content = readFileSync(filePath, "utf-8"); } catch { return null; }

  const lines = content.split("\n").filter(l => l.trim());
  if (lines.length === 0) return null;

  let sessionId = basename(filePath, ".jsonl");
  let timestamp = "";
  let lastActivity = "";
  let summary = "";
  let messageCount = 0;

  for (const line of lines) {
    try {
      const entry = JSON.parse(line);

      // Get session ID and timestamp from first entry
      if (!timestamp) {
        sessionId = entry.sessionId ?? sessionId;
        timestamp = entry.timestamp ?? "";
      }
      lastActivity = entry.timestamp ?? lastActivity;

      // Count messages
      if (entry.type === "user" || entry.type === "assistant") {
        messageCount++;
      }

      // Extract first user message as summary
      if (entry.type === "user" && !summary) {
        const msg = entry.message;
        if (msg) {
          const content = msg.content;
          if (typeof content === "string") {
            summary = content;
          } else if (Array.isArray(content)) {
            summary = content
              .filter((c: any) => c.type === "text")
              .map((c: any) => c.text)
              .join(" ");
          }
          // Truncate and clean
          summary = summary.replace(/<[^>]+>/g, " ").trim().slice(0, 200);
        }
      }
    } catch {}
  }

  return { sessionId, timestamp, lastActivity, summary, messageCount };
}

/**
 * List all Claude Code sessions from disk.
 * Scans ~/.claude/projects/ by default.
 */
export function listClaudeSessions(opts?: ListOpts): ClaudeSession[] {
  const baseDir = opts?.baseDir ?? join(homedir(), ".claude", "projects");
  const limit = opts?.limit ?? 100;

  if (!existsSync(baseDir)) return [];

  const sessions: ClaudeSession[] = [];

  for (const projectDir of readdirSync(baseDir)) {
    const projectPath = join(baseDir, projectDir);

    // Skip non-directories
    try { if (!statSync(projectPath).isDirectory()) continue; } catch { continue; }

    // Filter by project if specified
    const decodedProject = decodeProjectDir(projectDir);
    if (opts?.project && !decodedProject.toLowerCase().includes(opts.project.toLowerCase())) continue;

    // Find JSONL files (skip subdirectories which contain subagent transcripts)
    let files: string[];
    try {
      files = readdirSync(projectPath).filter(f => f.endsWith(".jsonl"));
    } catch { continue; }

    for (const file of files) {
      const filePath = join(projectPath, file);

      // Skip if it's not a regular file
      try { if (!statSync(filePath).isFile()) continue; } catch { continue; }

      const meta = parseTranscriptMeta(filePath);
      if (!meta) continue;

      sessions.push({
        ...meta,
        project: decodedProject,
        projectDir,
        transcriptPath: filePath,
      });
    }
  }

  // Sort by most recent first
  sessions.sort((a, b) => (b.lastActivity || b.timestamp).localeCompare(a.lastActivity || a.timestamp));

  return sessions.slice(0, limit);
}

/**
 * Find a specific Claude session by ID.
 */
export function getClaudeSession(sessionId: string, opts?: ListOpts): ClaudeSession | null {
  const all = listClaudeSessions({ ...opts, limit: 10000 });
  return all.find(s => s.sessionId === sessionId) ?? null;
}
```

- [ ] **Step 4: Add re-export in index.ts**

```ts
export { listClaudeSessions, getClaudeSession, type ClaudeSession } from "./claude-sessions.js";
```

- [ ] **Step 5: Run tests until green**

Run: `bun test packages/core/__tests__/claude-sessions.test.ts`

- [ ] **Step 6: Commit**

```bash
git add packages/core/claude-sessions.ts packages/core/index.ts packages/core/__tests__/claude-sessions.test.ts
git commit -m "feat: discover Claude Code sessions from disk — listClaudeSessions/getClaudeSession"
```

---

### Task 2: CLI commands — `ark claude list` + `ark session import`

**Files:**
- Modify: `packages/cli/index.ts`

- [ ] **Step 1: Add `ark claude list` command**

```ts
// ── Claude session discovery ────────────────────────────────────────────────

const claude = program.command("claude").description("Interact with Claude Code sessions");

claude.command("list")
  .description("List Claude Code sessions found on disk")
  .option("-p, --project <filter>", "Filter by project path")
  .option("-l, --limit <n>", "Max results", "20")
  .action((opts) => {
    const sessions = core.listClaudeSessions({
      project: opts.project,
      limit: parseInt(opts.limit),
    });

    if (sessions.length === 0) {
      console.log(chalk.yellow("No Claude sessions found."));
      return;
    }

    console.log(chalk.bold(`Found ${sessions.length} Claude session(s):\n`));
    for (const s of sessions) {
      const date = s.lastActivity?.slice(0, 10) ?? s.timestamp?.slice(0, 10) ?? "?";
      const msgs = chalk.dim(`${s.messageCount} msgs`);
      const proj = chalk.cyan(s.project.split("/").slice(-2).join("/"));
      const summary = s.summary ? s.summary.slice(0, 80) : chalk.dim("(no summary)");
      console.log(`  ${chalk.dim(s.sessionId.slice(0, 8))}  ${date}  ${proj}  ${msgs}  ${summary}`);
    }
    console.log(chalk.dim(`\nUse: ark session import --claude-session <id> --repo <path>`));
  });
```

- [ ] **Step 2: Add `--claude-session` flag to `ark session start`**

In the existing `session.command("start")`, add an option:

```ts
  .option("--claude-session <id>", "Import from an existing Claude Code session (use 'ark claude list' to find IDs)")
```

In the action handler, if `opts.claudeSession` is set:

```ts
    // Import from Claude session
    if (opts.claudeSession) {
      const claudeSession = core.getClaudeSession(opts.claudeSession);
      if (!claudeSession) {
        // Try prefix match
        const all = core.listClaudeSessions({ limit: 1000 });
        const match = all.find(s => s.sessionId.startsWith(opts.claudeSession));
        if (!match) {
          console.log(chalk.red(`Claude session '${opts.claudeSession}' not found. Run 'ark claude list' to see available sessions.`));
          return;
        }
        Object.assign(opts, {
          summary: opts.summary ?? match.summary?.slice(0, 100),
          repo: opts.repo ?? match.project,
        });
        // Store the claude session ID for --resume
        opts._claudeSessionId = match.sessionId;
        opts._workdir = workdir ?? match.project;
      } else {
        opts.summary = opts.summary ?? claudeSession.summary?.slice(0, 100);
        opts.repo = opts.repo ?? claudeSession.project;
        opts._claudeSessionId = claudeSession.sessionId;
        opts._workdir = workdir ?? claudeSession.project;
      }
    }
```

Then when creating the session, pass the claude_session_id:

```ts
    const s = core.startSession({
      ticket, summary: opts.summary ?? ticket,
      repo, flow: opts.flow, compute_name: opts.compute,
      workdir: opts._workdir ?? workdir, group_name: opts.group,
    });

    // If importing from Claude, set the claude_session_id for --resume
    if (opts._claudeSessionId) {
      core.updateSession(s.id, { claude_session_id: opts._claudeSessionId });
    }
```

This means when the Ark session is dispatched, `buildLauncher` will use `--resume <claude_session_id>` to continue the conversation.

- [ ] **Step 3: Test manually**

```bash
bun run packages/cli/index.ts claude list
bun run packages/cli/index.ts claude list --project ark
bun run packages/cli/index.ts session start --claude-session <first-8-chars> --flow bare
```

- [ ] **Step 4: Commit**

```bash
git add packages/cli/index.ts
git commit -m "feat: ark claude list + session start --claude-session for importing Claude sessions"
```

---

### Task 3: TUI — import Claude session from new session flow

**Files:**
- Modify: `packages/tui/tabs/SessionsTab.tsx` (or the new session form)

When the user presses `n` to create a new session, add an option to import from a Claude session. This could be:
- A new key `I` (capital i) that opens a Claude session picker directly
- Or an option in the new session form

The simpler approach: add an `I` key handler in SessionsTab that:
1. Calls `core.listClaudeSessions({ limit: 20 })`
2. Shows a selection list (using the existing SelectMenu or ink-select-input)
3. On selection, creates an Ark session pre-filled with the Claude session's project/summary
4. Sets `claude_session_id` on the Ark session

- [ ] **Step 1: Add `I` key handler in SessionsTab**

In the main `useInput` handler, alongside `n` for new session:

```ts
    if (input === "I") {
      // Show Claude session import picker
      setClaudeImportMode(true);
      return;
    }
```

- [ ] **Step 2: Add Claude session picker overlay**

When `claudeImportMode` is true, render a list of Claude sessions. On selection:

```ts
    const selected = claudeSessions[selectedIndex];
    const s = core.startSession({
      summary: selected.summary?.slice(0, 100) || `Imported from ${selected.sessionId.slice(0, 8)}`,
      repo: selected.project,
      workdir: selected.project,
      flow: "bare",
    });
    core.updateSession(s.id, { claude_session_id: selected.sessionId });
    status.show(`Imported Claude session ${selected.sessionId.slice(0, 8)}`);
    setClaudeImportMode(false);
    refresh();
```

- [ ] **Step 3: Test manually in TUI**

1. Start TUI: `bun run packages/cli/index.ts tui`
2. Press `I` on Sessions tab
3. Select a Claude session
4. Verify Ark session created with correct project/summary

- [ ] **Step 4: Commit**

```bash
git add packages/tui/tabs/SessionsTab.tsx
git commit -m "feat: TUI 'I' key imports Claude session into Ark"
```
