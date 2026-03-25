# Session Search — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add grep-style search across Claude transcripts, Ark event logs, and session metadata — CLI command + TUI integration.

**Architecture:** A new `search.ts` module in core provides `searchSessions(query, opts)` that searches three sources: (1) Ark's SQLite event/message tables via SQL LIKE, (2) Claude transcript JSONL files via line-by-line grep, (3) session metadata (summary, ticket, repo). Results are unified into a common `SearchResult` type. CLI exposes `ark search <query>`. TUI adds `/` search in the Sessions tab.

**Tech Stack:** SQLite LIKE queries, JSONL line scanning, existing CLI (Commander), existing TUI (Ink)

---

## File Structure

| File | Change |
|------|--------|
| `packages/core/search.ts` | **Create:** Search engine — `searchSessions()`, `searchTranscripts()`, `searchEvents()` |
| `packages/core/index.ts` | **Modify:** Re-export search module |
| `packages/core/__tests__/search.test.ts` | **Create:** Tests for search functions |
| `packages/cli/index.ts` | **Modify:** Add `ark search <query>` command |

TUI integration (filtering sessions by search) is a follow-up — the core + CLI is the deliverable here.

---

### Task 1: Core search module — searchSessions

**Files:**
- Create: `packages/core/search.ts`
- Create: `packages/core/__tests__/search.test.ts`
- Modify: `packages/core/index.ts`

- [ ] **Step 1: Write the test file**

```ts
/**
 * Tests for search.ts — session search across metadata, events, messages, and transcripts.
 */

import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import {
  createTestContext, setContext, resetContext,
  type TestContext,
} from "../context.js";
import {
  createSession, logEvent, addMessage, updateSession,
} from "../store.js";
import { searchSessions, searchTranscripts, type SearchResult } from "../search.js";

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

describe("searchSessions", () => {
  it("finds sessions by summary text", () => {
    createSession({ summary: "Fix authentication bug in login flow" });
    createSession({ summary: "Add dark mode to settings page" });

    const results = searchSessions("authentication");
    expect(results.length).toBe(1);
    expect(results[0].sessionId).toBeDefined();
    expect(results[0].source).toBe("metadata");
    expect(results[0].match).toContain("authentication");
  });

  it("finds sessions by ticket/jira_key", () => {
    createSession({ ticket: "PROJ-123", summary: "Some work" });
    createSession({ ticket: "PROJ-456", summary: "Other work" });

    const results = searchSessions("PROJ-123");
    expect(results.length).toBe(1);
  });

  it("finds sessions by repo name", () => {
    createSession({ summary: "Work", repo: "/Users/dev/myapp" });
    createSession({ summary: "Other", repo: "/Users/dev/other" });

    const results = searchSessions("myapp");
    expect(results.length).toBe(1);
  });

  it("searches event data", () => {
    const s = createSession({ summary: "Test session" });
    logEvent(s.id, "stage_started", { actor: "user", data: { agent: "implementer", model: "opus" } });

    const results = searchSessions("implementer");
    expect(results.some(r => r.source === "event")).toBe(true);
  });

  it("searches messages", () => {
    const s = createSession({ summary: "Chat session" });
    addMessage({ session_id: s.id, role: "agent", content: "I found a critical SQL injection vulnerability" });

    const results = searchSessions("SQL injection");
    expect(results.some(r => r.source === "message")).toBe(true);
  });

  it("returns empty array for no matches", () => {
    createSession({ summary: "Something" });
    expect(searchSessions("nonexistent_xyz_123")).toEqual([]);
  });

  it("is case-insensitive", () => {
    createSession({ summary: "Fix Authentication Bug" });
    const results = searchSessions("authentication");
    expect(results.length).toBe(1);
  });

  it("limits results", () => {
    for (let i = 0; i < 20; i++) {
      createSession({ summary: `Task number ${i} for search` });
    }
    const results = searchSessions("search", { limit: 5 });
    expect(results.length).toBe(5);
  });

  it("deduplicates by session ID", () => {
    const s = createSession({ summary: "Search target keyword" });
    addMessage({ session_id: s.id, role: "agent", content: "Working on search target keyword" });
    logEvent(s.id, "note", { data: { text: "search target keyword" } });

    const results = searchSessions("target keyword");
    // Multiple sources may match but session should appear with best match
    const sessionIds = results.map(r => r.sessionId);
    const unique = new Set(sessionIds);
    expect(unique.size).toBe(sessionIds.length);
  });
});

describe("searchTranscripts", () => {
  it("finds matches in Claude transcript JSONL", () => {
    // Create a fake transcript in the expected location
    const projectDir = join(ctx.arkDir, "claude-projects", "-test-project");
    mkdirSync(projectDir, { recursive: true });
    const transcriptPath = join(projectDir, "session-abc.jsonl");
    writeFileSync(transcriptPath, [
      JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: "fix the database migration" }] } }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "I'll fix the migration by adding a new column" }] } }),
    ].join("\n"));

    const results = searchTranscripts("migration", { transcriptsDir: join(ctx.arkDir, "claude-projects") });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].match).toContain("migration");
  });

  it("returns empty for no transcript matches", () => {
    const results = searchTranscripts("nonexistent_xyz", { transcriptsDir: "/tmp/no-such-dir" });
    expect(results).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/core/__tests__/search.test.ts`
Expected: FAIL — `search.ts` doesn't exist.

- [ ] **Step 3: Implement search.ts**

Create `packages/core/search.ts`:

```ts
/**
 * Session search — grep across metadata, events, messages, and Claude transcripts.
 *
 * Three search sources:
 * 1. Session metadata (summary, ticket, repo) — SQL LIKE
 * 2. Events + messages — SQL LIKE on data/content
 * 3. Claude transcripts — JSONL line scanning
 */

import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { getContext } from "./context.js";

// Lazy import to avoid circular deps — store uses context, context doesn't use store
function getDb() {
  const { getDb } = require("./context.js");
  return getDb();
}

export interface SearchResult {
  sessionId: string;
  source: "metadata" | "event" | "message" | "transcript";
  match: string;
  timestamp?: string;
}

export interface SearchOpts {
  limit?: number;
  transcriptsDir?: string;
}

/**
 * Search across all sources: session metadata, events, messages.
 * Deduplicates by session ID (keeps first match per session per source).
 */
export function searchSessions(query: string, opts?: SearchOpts): SearchResult[] {
  const limit = opts?.limit ?? 50;
  const results: SearchResult[] = [];
  const seen = new Set<string>(); // sessionId:source dedup key

  const add = (r: SearchResult) => {
    const key = `${r.sessionId}:${r.source}`;
    if (seen.has(key)) return;
    seen.add(key);
    results.push(r);
  };

  // 1. Session metadata (summary, ticket, repo)
  const db = getDb();
  const pattern = `%${query}%`;
  const metaRows = db.prepare(
    `SELECT id, jira_key, jira_summary, repo, created_at FROM sessions
     WHERE jira_summary LIKE ? COLLATE NOCASE
        OR jira_key LIKE ? COLLATE NOCASE
        OR repo LIKE ? COLLATE NOCASE
     ORDER BY created_at DESC LIMIT ?`
  ).all(pattern, pattern, pattern, limit) as any[];

  for (const row of metaRows) {
    const match = row.jira_summary ?? row.jira_key ?? row.repo ?? "";
    add({ sessionId: row.id, source: "metadata", match, timestamp: row.created_at });
  }

  // 2. Events (search data JSON)
  const eventRows = db.prepare(
    `SELECT track_id, data, created_at FROM events
     WHERE data LIKE ? COLLATE NOCASE
     ORDER BY created_at DESC LIMIT ?`
  ).all(pattern, limit) as any[];

  for (const row of eventRows) {
    add({ sessionId: row.track_id, source: "event", match: row.data ?? "", timestamp: row.created_at });
  }

  // 3. Messages (search content)
  const msgRows = db.prepare(
    `SELECT session_id, content, created_at FROM messages
     WHERE content LIKE ? COLLATE NOCASE
     ORDER BY created_at DESC LIMIT ?`
  ).all(pattern, limit) as any[];

  for (const row of msgRows) {
    add({ sessionId: row.session_id, source: "message", match: row.content ?? "", timestamp: row.created_at });
  }

  return results.slice(0, limit);
}

/**
 * Search Claude Code transcript JSONL files for text matches.
 * Scans ~/.claude/projects/ by default.
 */
export function searchTranscripts(query: string, opts?: SearchOpts): SearchResult[] {
  const limit = opts?.limit ?? 50;
  const transcriptsDir = opts?.transcriptsDir ?? join(homedir(), ".claude", "projects");
  const results: SearchResult[] = [];
  const lowerQuery = query.toLowerCase();

  if (!existsSync(transcriptsDir)) return results;

  for (const projectDir of readdirSync(transcriptsDir)) {
    const projectPath = join(transcriptsDir, projectDir);
    let files: string[];
    try { files = readdirSync(projectPath).filter(f => f.endsWith(".jsonl")); } catch { continue; }

    for (const file of files) {
      if (results.length >= limit) return results;
      const filePath = join(projectPath, file);
      let content: string;
      try { content = readFileSync(filePath, "utf-8"); } catch { continue; }

      for (const line of content.split("\n")) {
        if (!line.trim()) continue;
        if (!line.toLowerCase().includes(lowerQuery)) continue;

        try {
          const entry = JSON.parse(line);
          // Extract readable text from the entry
          const text = extractText(entry);
          if (text.toLowerCase().includes(lowerQuery)) {
            const sessionId = file.replace(".jsonl", "");
            results.push({
              sessionId,
              source: "transcript",
              match: truncateAround(text, query, 120),
              timestamp: entry.timestamp,
            });
            break; // One match per file is enough
          }
        } catch {}
      }
    }
  }

  return results.slice(0, limit);
}

/** Extract readable text from a transcript JSONL entry. */
function extractText(entry: any): string {
  const msg = entry.message;
  if (!msg) return "";
  const content = msg.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((c: any) => c.type === "text")
      .map((c: any) => c.text)
      .join(" ");
  }
  return "";
}

/** Truncate text to show context around the match. */
function truncateAround(text: string, query: string, maxLen: number): string {
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return text.slice(0, maxLen);
  const start = Math.max(0, idx - 40);
  const end = Math.min(text.length, idx + query.length + 80);
  let result = text.slice(start, end);
  if (start > 0) result = "..." + result;
  if (end < text.length) result = result + "...";
  return result;
}
```

- [ ] **Step 4: Add re-export in index.ts**

In `packages/core/index.ts`, add:

```ts
export { searchSessions, searchTranscripts, type SearchResult, type SearchOpts } from "./search.js";
```

- [ ] **Step 5: Run tests until green**

Run: `bun test packages/core/__tests__/search.test.ts`

Note: The `getDb()` import pattern may need adjustment. If `context.ts` doesn't export `getDb` directly, import from store instead. Check what the actual exports are and adjust. The key is avoiding circular deps (search imports context/db, not store functions that import from context).

- [ ] **Step 6: Commit**

```bash
git add packages/core/search.ts packages/core/index.ts packages/core/__tests__/search.test.ts
git commit -m "feat: add session search across metadata, events, messages, and transcripts"
```

---

### Task 2: CLI command — `ark search`

**Files:**
- Modify: `packages/cli/index.ts`

- [ ] **Step 1: Add the search command**

After the existing session commands in `packages/cli/index.ts`, add:

```ts
// ── Search ──────────────────────────────────────────────────────────────────

program.command("search")
  .description("Search across sessions, events, messages, and transcripts")
  .argument("<query>", "Search text (case-insensitive)")
  .option("-l, --limit <n>", "Max results", "20")
  .option("-t, --transcripts", "Also search Claude transcripts (slower)")
  .action((query, opts) => {
    const limit = parseInt(opts.limit);
    const results = core.searchSessions(query, { limit });

    if (opts.transcripts) {
      const transcriptResults = core.searchTranscripts(query, { limit });
      results.push(...transcriptResults);
    }

    if (results.length === 0) {
      console.log(chalk.yellow("No results found."));
      return;
    }

    console.log(chalk.bold(`Found ${results.length} result(s) for "${query}":\n`));
    for (const r of results) {
      const sourceColor = r.source === "metadata" ? chalk.blue
        : r.source === "event" ? chalk.cyan
        : r.source === "message" ? chalk.green
        : chalk.magenta;
      const match = r.match.length > 120 ? r.match.slice(0, 120) + "..." : r.match;
      console.log(`  ${chalk.dim(r.sessionId)}  ${sourceColor(`[${r.source}]`)}  ${match}`);
    }
  });
```

- [ ] **Step 2: Test manually**

```bash
bun run packages/cli/index.ts search "test"
bun run packages/cli/index.ts search "test" --transcripts
bun run packages/cli/index.ts search "nonexistent_xyz"
```

- [ ] **Step 3: Commit**

```bash
git add packages/cli/index.ts
git commit -m "feat: add 'ark search' CLI command"
```

---

### Task 3: Push and verify

- [ ] **Step 1: Run all core tests**

Run: `bun test packages/core/__tests__/search.test.ts packages/core/__tests__/claude-hooks.test.ts packages/core/__tests__/claude-transcript.test.ts packages/core/__tests__/conductor-hooks.test.ts`

- [ ] **Step 2: Push**

```bash
git push
```
