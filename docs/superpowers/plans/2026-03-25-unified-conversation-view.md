# Unified Conversation View — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Unify conversation history across Sessions and History tabs — all powered by the FTS5 `transcript_index`, fed in real-time by hooks, with per-session and cross-session search.

**Architecture:** The FTS5 `transcript_index` table becomes the single source of truth for all conversation data. Hooks feed it in real-time (on `Stop`/`SessionEnd`). The Session detail pane reads conversation from FTS5 instead of raw tmux output. History tab already reads from FTS5. A new `searchSessionConversation(sessionId, query)` function enables per-session search. The `indexSession` function gets smarter — skips tool_use/tool_result entries, only indexes real conversation.

**Tech Stack:** SQLite FTS5, existing hooks infrastructure, existing search.ts module

---

## File Structure

| File | Change |
|------|--------|
| `packages/core/search.ts` | **Modify:** Add `getSessionConversation(sessionId)` and `searchSessionConversation(sessionId, query)` |
| `packages/core/index.ts` | **Modify:** Re-export new functions |
| `packages/core/conductor.ts` | **Modify:** Index on every `Stop` (not just `SessionEnd`) — more frequent updates |
| `packages/tui/tabs/SessionsTab.tsx` | **Modify:** Session detail shows conversation from FTS5, add `/` key for in-session search |
| `packages/tui/tabs/HistoryTab.tsx` | **Modify:** Conversation preview reads from FTS5 instead of file tail |
| `packages/core/__tests__/search.test.ts` | **Modify:** Add tests for new functions |
| `packages/tui/__tests__/e2e-conversation.test.ts` | **Create:** E2E tests for the full flow |

---

### Task 1: Add getSessionConversation and searchSessionConversation to search.ts

**Files:**
- Modify: `packages/core/search.ts`
- Modify: `packages/core/index.ts`
- Modify: `packages/core/__tests__/search.test.ts`

These two functions query the FTS5 index for a specific session:

```ts
/** Get conversation turns for a specific session, ordered by timestamp */
export function getSessionConversation(sessionId: string, opts?: { limit?: number }): { role: string; content: string; timestamp: string }[] {
  const db = getDb();
  const limit = opts?.limit ?? 100;
  try {
    return db.prepare(
      `SELECT role, content, timestamp FROM transcript_index
       WHERE session_id = ? ORDER BY rowid DESC LIMIT ?`
    ).all(sessionId, limit).reverse() as any[];
  } catch { return []; }
}

/** Search within a specific session's conversation */
export function searchSessionConversation(sessionId: string, query: string, opts?: { limit?: number }): SearchResult[] {
  const db = getDb();
  const limit = opts?.limit ?? 20;
  const ftsQuery = query.replace(/['"*()]/g, "").split(/\s+/).map(w => `"${w}"`).join(" ");
  try {
    const rows = db.prepare(
      `SELECT role, content, timestamp,
              snippet(transcript_index, 3, '>>>','<<<', '...', 30) as snippet
       FROM transcript_index
       WHERE session_id = ? AND transcript_index MATCH ?
       ORDER BY rank LIMIT ?`
    ).all(sessionId, ftsQuery, limit) as any[];
    return rows.map(r => ({
      sessionId,
      source: "transcript" as const,
      match: r.snippet || r.content?.slice(0, 120) || "",
      timestamp: r.timestamp,
    }));
  } catch { return []; }
}
```

Tests:
- `getSessionConversation` returns turns in order for a known session
- `getSessionConversation` returns empty for unknown session
- `searchSessionConversation` finds matches within a session
- `searchSessionConversation` does NOT return results from other sessions

Re-export from `index.ts`:
```ts
export { ..., getSessionConversation, searchSessionConversation } from "./search.js";
```

- [ ] **Step 1: Write tests**
- [ ] **Step 2: Run tests, verify they fail**
- [ ] **Step 3: Implement the functions**
- [ ] **Step 4: Run tests, verify they pass**
- [ ] **Step 5: Commit**

```bash
git commit -m "feat: getSessionConversation + searchSessionConversation — per-session FTS5 queries"
```

---

### Task 2: Improve indexSession — filter noise, support incremental

**Files:**
- Modify: `packages/core/search.ts` (the `indexSession` function)
- Modify: `packages/core/__tests__/search.test.ts`

Current `indexSession` reads the ENTIRE transcript file and indexes everything. Fix:
1. Read only the tail (64KB) for large files — same as `indexTranscripts`
2. Skip `tool_result` and `tool_use`-only entries (already done in `indexTranscripts` but not in `indexSession`)
3. Skip messages under 10 chars

Also: don't delete+reinsert on every call — check if the session already has entries and only add new ones (append-only). Use `rowid` or `timestamp` to determine what's new.

Tests:
- `indexSession` skips tool_result entries
- `indexSession` skips tool_use-only entries
- `indexSession` skips short messages
- `indexSession` on same file twice doesn't duplicate entries
- `indexSession` picks up new messages added since last index

- [ ] **Step 1: Write tests**
- [ ] **Step 2: Implement**
- [ ] **Step 3: Verify tests pass**
- [ ] **Step 4: Commit**

```bash
git commit -m "feat: indexSession filters noise + incremental append"
```

---

### Task 3: Session detail shows conversation from FTS5

**Files:**
- Modify: `packages/tui/tabs/SessionsTab.tsx`

The `SessionDetail` component currently shows live tmux output (`useAgentOutput`) but no conversation history. Add a conversation section that reads from FTS5:

1. Use `useMemo` or `useEffect` to call `core.getSessionConversation(s.claude_session_id || s.id)` when the session changes
2. Display conversation turns below the events section
3. Each turn shows `You:` or `Claude:` with the text, using `wrap="wrap"` for long messages
4. All I/O through `asyncState.run()` — load conversation asynchronously

The `claude_session_id` is the key that links an Ark session to its Claude transcript. If null, fall back to the Ark session ID.

- [ ] **Step 1: Add conversation state + loading**
- [ ] **Step 2: Display conversation turns in detail pane**
- [ ] **Step 3: Verify manually in TUI**
- [ ] **Step 4: Commit**

```bash
git commit -m "feat: session detail pane shows conversation history from FTS5"
```

---

### Task 4: In-session search (/ key in session detail)

**Files:**
- Modify: `packages/tui/tabs/SessionsTab.tsx`
- Modify: `packages/tui/components/StatusBar.tsx`

When viewing a session's right pane (detail), pressing `/` opens a search input. Typing a query + Enter filters the conversation to matching turns via `searchSessionConversation()`. Esc returns to full conversation view.

1. Add `searchMode` state to `SessionDetail`
2. Add `useInput` handler for `/` key when right pane is focused
3. Show `TextInputEnhanced` at the top of the detail pane when searching
4. Replace conversation display with search results when searching
5. Update StatusBar right-pane hints to include `/:search`
6. Signal overlay state to StatusBar via `onOverlayChange`

- [ ] **Step 1: Add search state + key handler**
- [ ] **Step 2: Add search input + results display**
- [ ] **Step 3: Update StatusBar hints**
- [ ] **Step 4: Verify manually**
- [ ] **Step 5: Commit**

```bash
git commit -m "feat: in-session search — / key searches conversation within a session"
```

---

### Task 5: History tab reads conversation from FTS5 instead of file tail

**Files:**
- Modify: `packages/tui/tabs/HistoryTab.tsx`

Replace the raw file tail read (lines 88-128) with `getSessionConversation()`:

```ts
// Before: reads 64KB from file tail, parses JSONL manually
// After: reads from FTS5 index
const turns = core.getSessionConversation(selectedItem.claudeSession.sessionId, { limit: 20 });
setConversationPreview(turns.map(t => `${t.role === "user" ? "You" : "Claude"}: ${t.content}`));
```

This eliminates:
- The `openSync`/`readSync`/`closeSync` file operations
- Manual JSONL parsing
- The junk filtering (already done at index time)

Falls back to empty if session isn't indexed yet (user hasn't pressed `r` or hooks haven't fired).

- [ ] **Step 1: Replace file read with FTS5 query**
- [ ] **Step 2: Remove fs imports no longer needed**
- [ ] **Step 3: Verify in TUI**
- [ ] **Step 4: Commit**

```bash
git commit -m "refactor: History conversation preview reads from FTS5 — no more file I/O"
```

---

### Task 6: Index more frequently — on every Stop hook, not just SessionEnd

**Files:**
- Modify: `packages/core/conductor.ts`

Currently `indexSession` is called on `Stop` and `SessionEnd`. The `Stop` hook fires after every agent turn — that's the right time to index because:
- The transcript has new content
- The user might switch to the session detail to see what happened

The current code already does this (line 165). Verify it works and that the incremental indexing (from Task 2) makes this cheap.

Also: on `UserPromptSubmit`, the user just sent a message. We could index that too — but it's redundant since `Stop` fires right after.

- [ ] **Step 1: Verify existing hook indexing works with incremental mode**
- [ ] **Step 2: Add test for the full flow: create session → post hook → verify indexed**
- [ ] **Step 3: Commit**

```bash
git commit -m "test: verify real-time indexing via hooks — Stop and SessionEnd"
```

---

### Task 7: E2E tests

**Files:**
- Create: `packages/core/__tests__/e2e-conversation.test.ts`

End-to-end tests for the full flow:

1. Create a session → write a fake transcript → post `Stop` hook → verify conversation appears in `getSessionConversation()`
2. Post `Stop` hook with updated transcript → verify new turns appear (incremental)
3. Search within a session → verify only that session's results
4. Search across sessions → verify cross-session results
5. Token usage appears on session config after hook

- [ ] **Step 1: Write all E2E tests**
- [ ] **Step 2: Run and fix**
- [ ] **Step 3: Run full test suite**
- [ ] **Step 4: Commit and push**

```bash
git commit -m "test: E2E tests for unified conversation view — hooks, indexing, search"
git push
```
