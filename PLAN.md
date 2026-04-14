# Plan: Chat Conversation Interface -- Add Send Message Capability

## Summary

The Web UI's chat/conversation interface is minimal: a collapsible single-line input that disappears after sending, no user message persistence, and 5-second polling. This plan upgrades it to a proper chat panel with persistent message history, optimistic sends, auto-scroll, and faster polling -- matching the TUI's `TalkToSession` experience and closing the surface parity gap between Web UI and TUI.

## Files to modify/create

| File | Change |
|------|--------|
| `packages/core/services/session-orchestration.ts` | Persist user message to `messages` table before sending to tmux (line ~2325) |
| `packages/server/handlers/messaging.ts` | Return the send result (ok + message) from the `message/send` handler |
| `packages/web/src/components/ChatPanel.tsx` | **New file** -- dedicated chat panel component (message thread + input bar) |
| `packages/web/src/hooks/useMessages.ts` | **New file** -- web-side message hook with polling, send, optimistic updates |
| `packages/web/src/components/SessionDetail.tsx` | Replace inline send form with ChatPanel; wire chatOpen toggle |
| `packages/web/src/hooks/useSessionDetailData.ts` | Remove message fetching (now owned by ChatPanel's useMessages hook) |
| `packages/web/src/hooks/useApi.ts` | Add `markRead` method to api object |

## Implementation steps

### Step 1: Persist user messages on send (backend)

In `packages/core/services/session-orchestration.ts`, function `send()` (lines 2309-2328):

**Before** the `sendReliable()` call (after injection check passes, around line 2324), insert:
```ts
app.messages.send(sessionId, "user", message, "text");
```

This ensures every user-sent message appears in the conversation history, matching how agent messages are already persisted via the conductor channel (`conductor.ts` line ~664).

### Step 2: Return send result from `message/send` RPC

In `packages/server/handlers/messaging.ts`, the `message/send` handler (lines 7-11):

Change the handler to return the actual result from `sessionService.send()`:
```ts
router.handle("message/send", async (p) => {
  const { sessionId, content } = extract<MessageSendParams>(p, ["sessionId", "content"]);
  const result = await app.sessionService.send(sessionId, content);
  return result;
});
```

The result already has `{ ok: boolean, message: string }` from `session-orchestration.send()`. This lets the client know if delivery failed (no active session, prompt injection blocked, etc.).

### Step 3: Add `markRead` to web API

In `packages/web/src/hooks/useApi.ts`, add after the `send` method (line 76):
```ts
markRead: (id: string) => rpc<any>("message/markRead", { sessionId: id }),
```

### Step 4: Create `useMessages` hook for the web

Create `packages/web/src/hooks/useMessages.ts`:

```ts
interface UseMessagesOpts {
  sessionId: string;
  enabled: boolean;    // only poll when chat panel is open
  pollMs?: number;     // default 2000ms
}

interface UseMessagesResult {
  messages: Message[];
  send: (content: string) => Promise<void>;
  sending: boolean;
}
```

Behavior:
- On mount and at `pollMs` intervals (when `enabled`): call `api.getMessages(sessionId)`, then `api.markRead(sessionId)`
- `send(content)`: optimistically add a user message to local state, call `api.send(sessionId, content)`, then refetch on next poll
- On `sessionId` change: reset messages and reload immediately
- Only poll when `enabled` is true (stops 2s polling when chat panel is closed)
- Optimistic messages use a negative temp `id` and get deduped on next poll by matching `role + content + created_at` proximity

### Step 5: Create `ChatPanel` component

Create `packages/web/src/components/ChatPanel.tsx`:

```
<div className="flex flex-col h-full">
  {/* Header: "Chat: <summary>" + close button */}
  <div className="h-10 border-b px-4 flex items-center justify-between shrink-0">
    <span>Chat: {session.summary || session.id}</span>
    <Button variant="ghost" size="icon-xs" onClick={onClose}><X /></Button>
  </div>

  {/* Messages: scrollable, auto-scroll to bottom */}
  <div className="flex-1 overflow-y-auto p-3 flex flex-col gap-1.5">
    {messages.length === 0 && <EmptyState />}
    {messages.map(m => <ChatBubble key={m.id} message={m} />)}
    <div ref={bottomRef} />
  </div>

  {/* Input bar: always visible at bottom */}
  <div className="border-t p-2 flex gap-2 shrink-0">
    <Input placeholder="Message to agent..."
      value={msg} onChange={...}
      onKeyDown={Enter -> send}
      autoFocus />
    <Button size="xs" disabled={!msg.trim() || sending}
      onClick={send}>Send</Button>
  </div>
</div>
```

Chat bubble styling (reuse existing patterns from SessionDetail.tsx lines 556-575):
- User messages: `bg-primary/10 border-primary/20 self-end` (right-aligned)
- Agent/system messages: `bg-secondary border-border self-start` (left-aligned)
- Badge for non-text types (progress, question, completed, error)
- Timestamp via `relTime()`
- Empty state: "No messages yet. Type below to send."

Auto-scroll: use a `useEffect` that scrolls `bottomRef` into view when messages change, unless user has scrolled up (track via `onScroll` event checking if scrollTop + clientHeight < scrollHeight - threshold).

### Step 6: Integrate ChatPanel into SessionDetail

In `packages/web/src/components/SessionDetail.tsx`:

1. **Simplify SessionActions** (lines 30-109): Remove the inline send form (state variables `sendMsg`, `showSendInternal`, lines 32-33, 79-106). The "Send" button now only toggles `chatOpen` via `onChatOpenChange`:
```tsx
{(s === "running" || s === "waiting") && (
  <Button variant={chatOpen ? "default" : "outline"} size="xs"
    onClick={() => onChatOpenChange?.(!chatOpen)}>
    {chatOpen ? "Close Chat" : "Chat"}
  </Button>
)}
```

2. **Conditional render**: When `chatOpen` is true, render `ChatPanel` in place of the scrollable detail content area:
```tsx
<div className="flex flex-col h-full bg-background">
  {/* Header */}
  <div className="h-[52px] ...">...</div>

  {chatOpen ? (
    <ChatPanel
      sessionId={sessionId}
      session={s}
      onClose={() => onChatOpenChange?.(false)}
      onToast={onToast}
    />
  ) : (
    <div className="flex-1 overflow-y-auto p-5">
      {/* existing detail content (metadata, todos, events, etc.) */}
      {/* Keep the Conversation section here for non-active sessions */}
    </div>
  )}
</div>
```

3. **Keep Conversation section for non-active sessions**: The existing message display at lines 547-579 remains in the detail view for completed/stopped sessions where chat isn't available. But when chat is open, it's not shown (ChatPanel owns message display).

### Step 7: Clean up useSessionDetailData

In `packages/web/src/hooks/useSessionDetailData.ts`:

- Remove `messages` state (line 36) and both message-fetching effects (lines 55-60 for initial load, line 88-89 in the poll)
- Remove `messages` from the return type and return value
- In `SessionDetail.tsx`, remove `messages` from the destructured hook result (line 112)
- For the "Conversation" section in the detail view (non-chat mode), fetch messages inline or keep a lightweight read-only version

**However**, to keep the Conversation section working in the detail view for non-active sessions, we have two options:
- (a) Keep the message fetch in `useSessionDetailData` but only for non-active sessions (no polling needed for completed sessions)
- (b) Have `SessionDetail` conditionally fetch messages for the static Conversation display

**Recommendation**: option (a) -- keep a single initial fetch of messages in `useSessionDetailData` (no polling), remove the polling effect. ChatPanel handles its own fast polling when active.

## Testing strategy

1. **Manual verification (critical path)**:
   - Start a running session, open chat (`t` key or click Chat button), send a message -- verify it appears immediately
   - Verify the message reaches the agent (check tmux pane: `tmux capture-pane -t ark-s-<id> -p`)
   - Wait for agent response -- verify it appears in chat within ~2 seconds
   - Send several messages, confirm auto-scroll keeps latest visible
   - Scroll up manually, confirm new messages don't yank viewport down
   - Close chat (Escape or click close), reopen -- verify full history preserved
   - Switch to a different session -- verify chat resets

2. **Backend persistence test**:
   - Send a message via RPC: `{"method":"message/send","params":{"sessionId":"s-xxx","content":"hello"}}`
   - Query messages: `{"method":"session/messages","params":{"sessionId":"s-xxx"}}`
   - Verify the user message appears with `role:"user"`, `type:"text"`
   - Send from agent (via channel report), query again -- verify interleaved correctly

3. **Edge cases**:
   - Send to a stopped/completed session -- verify error toast
   - Empty message -- verify send button disabled, Enter does nothing
   - Very long message -- verify wrapping in bubble, no horizontal overflow
   - Rapid sends -- verify no duplicate optimistic messages
   - Session transitions running->completed while chat open -- verify input disables gracefully
   - Prompt injection -- verify blocked message shows error toast

4. **Keyboard shortcuts** (already wired, verify still working):
   - `t` toggles chat open/close (SessionsPage.tsx:91-98)
   - `Escape` closes chat (SessionsPage.tsx:113)
   - `Enter` in input sends message

## Risk assessment

1. **User message double-persistence** -- Low risk. Currently zero user messages are persisted. After this change, exactly one `INSERT` per send in `session-orchestration.send()`. No other code path persists user messages. The TUI's `useMessages` hook calls `ark.messageSend()` which hits the same `message/send` RPC, so this fix benefits both surfaces.

2. **Polling load** -- Low risk. The 2s poll only runs when chat is open (one session at a time). We remove the message fetch from the 5s detail poll, so net polling stays similar. Messages are a lightweight query (50 rows max, single-table SELECT with LIMIT).

3. **Optimistic message ordering** -- The optimistic message has a temp negative `id`. On next 2s poll, the real DB message replaces it. Brief flicker is possible if poll races with render, but content will be identical. Dedup by matching `role === "user" && content === optimistic.content` within a 5-second window.

4. **No breaking API changes** -- The `message/send` RPC response changes from always `{ ok: true }` to `{ ok: boolean, message: string }`. Extra fields are additive. The existing web UI already handles `res.ok !== false` (SessionDetail.tsx:236-240). The TUI's `useMessages` hook calls `ark.messageSend()` which uses `ArkClient.messageSend()` -- it ignores the response entirely (`await this.rpc(...)` with no return processing), so no breakage.

5. **ChatPanel layout** -- Medium risk. The panel replaces the detail view content area. If the panel's flex layout doesn't fill height correctly, the input bar could float or the messages area could overflow. Test across different viewport heights. The existing `SessionDetail` already uses `flex flex-col h-full`, so the structure is proven.

## Open questions

1. **Should chat be a side panel or replace the detail view?** This plan uses full replacement (chat replaces detail when open). A split layout (detail + chat side by side) would require wider minimum widths. **Recommendation**: full replacement is simpler and matches TUI behavior.

2. **Should we add SSE for messages?** Currently the SSE stream only sends session status. Adding per-session message events would eliminate polling. **Recommendation**: defer to follow-up; 2s polling is adequate for chat and matches TUI.

3. **Should chat work for non-running sessions (read-only)?** Currently the Chat button only appears for running/waiting sessions. Completed sessions show the static Conversation section in detail view. **Recommendation**: keep this split -- chat with input for active sessions, read-only conversation display for inactive sessions.
