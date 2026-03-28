# Messaging Service Refactor

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Centralize all message operations (store, send, poll, deliver) into a single `useMessages` hook. Remove inline message manipulation from Chat and Threads panels. Both panels use the same hook with the same API.

**Architecture:** Create `useMessages` hook in `packages/tui/hooks/useMessages.ts` that owns message state, provides `send()` (store + deliver + update state), polls for new messages, and exposes typed message arrays. The hook wraps `core.addMessage`, `core.getMessages`, and channel delivery. Chat and Threads both consume this hook.

**Tech Stack:** TypeScript, React hooks, bun:test

---

## File Structure

| File | Role | Change Type |
|------|------|-------------|
| `packages/tui/hooks/useMessages.ts` | Message hook | Create |
| `packages/tui/hooks/__tests__/useMessages.test.tsx` | Tests | Create |
| `packages/tui/tabs/SessionsTab.tsx` | Chat panel | Modify: use useMessages |
| `packages/tui/components/ThreadsPanel.tsx` | Threads panel | Modify: use useMessages |

---

### Task 1: Create useMessages Hook

**Files:**
- Create: `packages/tui/hooks/useMessages.ts`
- Create: `packages/tui/hooks/__tests__/useMessages.test.tsx`

- [ ] **Step 1: Write failing tests**

Create `packages/tui/hooks/__tests__/useMessages.test.tsx`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createTestContext, setContext } from "../../../core/context.js";
import * as core from "../../../core/index.js";
import type { TestContext } from "../../../core/context.js";

let ctx: TestContext;
beforeEach(() => { ctx = createTestContext(); setContext(ctx); });
afterEach(() => { ctx.cleanup(); });

describe("useMessages internals", () => {
  it("getMessages returns stored messages", () => {
    const session = core.startSession({ summary: "msg-test", repo: "test", flow: "bare", workdir: "/tmp" });
    core.addMessage({ session_id: session.id, role: "user", content: "hello" });
    core.addMessage({ session_id: session.id, role: "agent", content: "hi back", type: "progress" });
    const msgs = core.getMessages(session.id, { limit: 10 });
    expect(msgs.length).toBe(2);
    expect(msgs[0].role).toBe("user");
    expect(msgs[0].content).toBe("hello");
    expect(msgs[1].role).toBe("agent");
    expect(msgs[1].type).toBe("progress");
  });

  it("getMessages respects limit", () => {
    const session = core.startSession({ summary: "msg-limit", repo: "test", flow: "bare", workdir: "/tmp" });
    for (let i = 0; i < 10; i++) {
      core.addMessage({ session_id: session.id, role: "user", content: `msg ${i}` });
    }
    const msgs = core.getMessages(session.id, { limit: 3 });
    expect(msgs.length).toBe(3);
  });

  it("messages from multiple sessions stay separate", () => {
    const s1 = core.startSession({ summary: "s1", repo: "test", flow: "bare", workdir: "/tmp" });
    const s2 = core.startSession({ summary: "s2", repo: "test", flow: "bare", workdir: "/tmp" });
    core.addMessage({ session_id: s1.id, role: "user", content: "for s1" });
    core.addMessage({ session_id: s2.id, role: "user", content: "for s2" });
    expect(core.getMessages(s1.id, { limit: 10 }).length).toBe(1);
    expect(core.getMessages(s2.id, { limit: 10 }).length).toBe(1);
    expect(core.getMessages(s1.id, { limit: 10 })[0].content).toBe("for s1");
  });
});
```

- [ ] **Step 2: Run tests to verify they pass** (these test core functions that already exist)

Run: `bun test packages/tui/hooks/__tests__/useMessages.test.tsx --timeout 15000`

- [ ] **Step 3: Create the useMessages hook**

Create `packages/tui/hooks/useMessages.ts`:

```typescript
/**
 * Centralized message state management.
 *
 * Owns all message operations: store, send, deliver, poll.
 * Both Chat (1:1) and Threads (multi-session) consume this hook.
 */

import { useState, useEffect, useCallback, useRef } from "react";
import * as core from "../../core/index.js";

export interface MessageEntry {
  id: number;
  session_id: string;
  role: string;
  content: string;
  type: string;
  created_at: string;
  read: number;
}

export interface ThreadMessage extends MessageEntry {
  sessionName: string;
  time: string;
}

interface UseMessagesOpts {
  /** Session ID for 1:1 chat mode. Null for threads (multi-session). */
  sessionId?: string | null;
  /** All sessions to aggregate (threads mode). */
  sessions?: core.Session[];
  /** Poll interval in ms. Default 2000. */
  pollMs?: number;
  /** Max messages to load. Default 30. */
  limit?: number;
}

interface UseMessagesResult {
  /** Messages for display (single session or aggregated). */
  messages: ThreadMessage[];
  /** Send a message to a session. Stores locally + delivers via channel. */
  send: (targetSessionId: string, content: string) => void;
  /** Whether a delivery is in progress. */
  sending: boolean;
  /** Last delivery error, if any. */
  error: string | null;
}

export function useMessages(opts: UseMessagesOpts): UseMessagesResult {
  const { sessionId, sessions, pollMs = 2000, limit = 30 } = opts;
  const [messages, setMessages] = useState<ThreadMessage[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const running = useRef(false);

  // Load messages - either single session or multi-session
  const loadMessages = useCallback(() => {
    if (sessionId) {
      // 1:1 chat mode
      const msgs = core.getMessages(sessionId, { limit });
      setMessages(msgs.map(m => ({
        ...m,
        sessionName: "",
        time: m.created_at.slice(11, 16),
      })));
    } else if (sessions?.length) {
      // Threads mode - aggregate across sessions
      const all: ThreadMessage[] = [];
      for (const s of sessions) {
        const msgs = core.getMessages(s.id, { limit });
        const name = s.summary ?? s.id.slice(0, 8);
        for (const m of msgs) {
          all.push({
            ...m,
            sessionName: name,
            time: m.created_at.slice(11, 16),
          });
        }
      }
      all.sort((a, b) => a.id - b.id);
      setMessages(all.slice(-limit));
    }
  }, [sessionId, sessions, limit]);

  // Poll for new messages
  useEffect(() => {
    loadMessages();
    const t = setInterval(loadMessages, pollMs);
    return () => clearInterval(t);
  }, [loadMessages, pollMs]);

  // Send: store locally, update state, deliver via channel
  const send = useCallback((targetSessionId: string, content: string) => {
    // Store immediately
    core.addMessage({ session_id: targetSessionId, role: "user", content });
    // Refresh state so message appears instantly
    loadMessages();
    // Mark read
    core.markMessagesRead(targetSessionId);

    // Deliver via channel (fire and forget with error tracking)
    setSending(true);
    setError(null);
    const channelPort = core.sessionChannelPort(targetSessionId);
    fetch(`http://localhost:${channelPort}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "steer",
        sessionId: targetSessionId,
        message: content,
        from: "user",
      }),
    })
      .then(() => { setSending(false); })
      .catch(() => {
        core.addMessage({
          session_id: targetSessionId,
          role: "system",
          content: `Failed to deliver (port ${channelPort})`,
          type: "error",
        });
        loadMessages();
        setSending(false);
        setError(`Failed to deliver to port ${channelPort}`);
      });
  }, [loadMessages]);

  return { messages, send, sending, error };
}
```

- [ ] **Step 4: Run tests**

Run: `bun test packages/tui/hooks/__tests__/useMessages.test.tsx --timeout 15000`

- [ ] **Step 5: Commit**

```bash
git add packages/tui/hooks/useMessages.ts packages/tui/hooks/__tests__/useMessages.test.tsx
git commit -m "feat: useMessages hook - centralized message state management"
```

---

### Task 2: Refactor TalkToSession (Chat) to use useMessages

**Files:**
- Modify: `packages/tui/tabs/SessionsTab.tsx`

- [ ] **Step 1: Replace inline message state in TalkToSession**

In the `TalkToSession` component, replace:
- `const [messages, setMessages] = useState<core.Message[]>([]);`
- The `useEffect` that loads/polls messages
- The `send` function with its inline `core.addMessage` + `fetch`

With:
```typescript
const { messages, send: sendMessage } = useMessages({
  sessionId: session.id,
  pollMs: 2000,
  limit: 20,
});

const send = () => {
  if (!msg.trim()) return;
  sendMessage(session.id, msg.trim());
  setMsg("");
};
```

- [ ] **Step 2: Update message rendering**

Messages from `useMessages` are `ThreadMessage` type with `time` field. Update the render to use `m.time` instead of `m.created_at.slice(11, 16)`.

- [ ] **Step 3: Remove unused imports**

Remove any `core.addMessage`, `core.getMessages`, `core.markMessagesRead` direct calls from TalkToSession. The hook handles all of it.

- [ ] **Step 4: Run smoke test**

Run: `bun packages/cli/index.ts --help` (verify no import errors)

- [ ] **Step 5: Commit**

```bash
git add packages/tui/tabs/SessionsTab.tsx
git commit -m "refactor: TalkToSession uses useMessages hook"
```

---

### Task 3: Refactor ThreadsPanel to use useMessages

**Files:**
- Modify: `packages/tui/components/ThreadsPanel.tsx`

- [ ] **Step 1: Replace inline message state in ThreadsPanel**

Remove:
- `const [allMessages, setAllMessages] = useState([]);`
- The `useEffect` that loads/polls messages from all sessions
- The inline `send` function's `core.addMessage` + `fetch` + manual state reload

Replace with:
```typescript
const { messages: allMessages, send: sendMessage } = useMessages({
  sessions,
  pollMs: 2000,
  limit: 30,
});
```

Update the `send` function to use `sendMessage(targetId, content)` and just handle the `@session-name` parsing.

- [ ] **Step 2: Remove the visible slice**

The hook already limits messages. Remove `const visible = allMessages.slice(-30);` and use `allMessages` directly (it's already limited by the hook).

- [ ] **Step 3: Remove unused imports**

Remove direct `core.addMessage`, `core.getMessages`, `core.markMessagesRead` calls. Keep `core.sessionChannelPort` only if still needed (it shouldn't be - the hook handles delivery).

- [ ] **Step 4: Run tests**

Run: `bun test packages/tui/__tests__/ThreadsPanel.test.tsx --timeout 15000`

- [ ] **Step 5: Commit**

```bash
git add packages/tui/components/ThreadsPanel.tsx
git commit -m "refactor: ThreadsPanel uses useMessages hook"
```

---

### Task 4: Final Verification

- [ ] **Step 1: Run full test suite**

Run: `bun test --timeout 30000 $(find packages -name '*.test.ts' -o -name '*.test.tsx' | grep -v e2e | sort)`

- [ ] **Step 2: Verify no direct message manipulation remains**

Run: `grep -rn "core\.addMessage\|core\.getMessages\|core\.markMessagesRead" packages/tui/ --include="*.ts" --include="*.tsx" | grep -v __tests__ | grep -v useMessages`
Expected: Zero matches (all message ops go through the hook)

- [ ] **Step 3: Push and verify CI**

```bash
git push origin main
```
Expected: CI ALL GREEN
