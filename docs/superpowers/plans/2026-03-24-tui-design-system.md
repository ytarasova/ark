# TUI Design System Cleanup — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enforce a consistent TUI design system: status bar is the single source of truth for shortcuts, spinners belong to panels, no inline hints anywhere.

**Architecture:** StatusBar becomes panel-aware (receives both `tab` and `pane` to show context-specific hints). All inline hint text ("Press X to...", "s:search /:index r:reload") removed from tab components. Panel spinners show progress detail; status bar spinner shows just the icon.

**Tech Stack:** Ink (React TUI), existing StatusBar/TabBar components

---

## Design Rules

1. **Status bar = only place for shortcut hints.** Updates based on active tab + active pane (left vs right) + active overlay (form, move, talk, etc.)
2. **Status bar spinner = icon only** (no label text). Shows the system is working.
3. **Panel spinners = detailed progress** inside the panel doing the work ("Indexing... 50 files, 3000 entries").
4. **No "Press X to Y" text inside panels.** That info goes in the status bar as `X:action`.
5. **Right pane hints** change based on what's shown (session detail, Claude session detail, etc.)

---

## File Structure

| File | Change |
|------|--------|
| `packages/tui/components/StatusBar.tsx` | **Major rewrite:** panel-aware hints, spinner icon only, per-tab per-pane hint functions |
| `packages/tui/tabs/SessionsTab.tsx` | **Remove:** inline "Enter to confirm, Esc to cancel" text in overlays |
| `packages/tui/tabs/HistoryTab.tsx` | **Remove:** "Enter to import into Ark" from detail pane, conversation limit |
| `packages/tui/tabs/ComputeTab.tsx` | **Remove:** any inline hints |
| `packages/tui/App.tsx` | **Modify:** pass `pane` and overlay state to StatusBar |

---

### Task 1: Rewrite StatusBar — panel-aware hints, spinner icon only

**Files:**
- Modify: `packages/tui/components/StatusBar.tsx`

The StatusBar currently receives: `tab`, `sessions`, `selectedSession`, `loading`, `error`, `label`, `pane`.

Add new props: `overlay` (which overlay is active — form, move, talk, group, search, etc.)

Rewrite the hint logic:

**Sessions tab, left pane, no overlay:**
`j/k:move Tab:detail n:new i:threads g:groups q:quit` + context-sensitive session hints (Enter/s/a/x/etc based on selected session status)

**Sessions tab, left pane, with overlay (e.g., move):**
`Enter:confirm Esc:cancel`

**Sessions tab, right pane:**
`j/k:scroll g/G:top/bottom Tab:back`

**History tab, left pane:**
`j/k:move Enter:import s:search /:index r:refresh q:quit`

**History tab, left pane, search mode:**
`Enter:search Esc:cancel`

**History tab, right pane:**
`j/k:scroll Tab:back`

**Compute tab, left pane:**
`Enter:provision s:start/stop c:clean n:new x:delete q:quit`

**Any tab, form overlay:**
`Enter:next Tab:field Esc:cancel`

**Spinner:** When `loading` is true, show just `⠋` (spinner icon) at the start of the status bar, no label text.

- [ ] **Step 1: Rewrite StatusBar.tsx**

```tsx
interface StatusBarProps {
  tab: Tab;
  sessions: Session[];
  selectedSession?: Session | null;
  loading: boolean;
  error: string | null;
  label: string | null;
  pane?: "left" | "right";
  overlay?: string | null; // "form" | "move" | "talk" | "group" | "inbox" | "clone" | "search" | null
}
```

Remove `label` from the spinner display — show only the spinner icon.

Rewrite hint functions to be panel-aware:

```tsx
function getHints(tab: Tab, pane: string, selectedSession: Session | null | undefined, overlay: string | null): React.ReactNode[] {
  // Overlay hints take priority
  if (overlay === "form") return [
    <KeyHint k="Enter" label="next" />,
    <KeyHint k="Esc" label="cancel" />,
  ];
  if (overlay === "move" || overlay === "clone" || overlay === "group") return [
    <KeyHint k="Enter" label="confirm" />,
    <KeyHint k="Esc" label="cancel" />,
  ];
  if (overlay === "talk") return [
    <KeyHint k="Enter" label="send" />,
    <KeyHint k="Esc" label="close" />,
  ];
  if (overlay === "search") return [
    <KeyHint k="Enter" label="search" />,
    <KeyHint k="Esc" label="cancel" />,
  ];

  // Right pane (same for all tabs)
  if (pane === "right") return [
    <KeyHint k="j/k" label="scroll" />,
    <KeyHint k="Tab" label="back" />,
  ];

  // Left pane, per-tab
  if (tab === "sessions") return getSessionHints(selectedSession);
  if (tab === "history") return getHistoryHints();
  if (tab === "compute") return getComputeHints();
  return getGenericHints();
}
```

Update `getSessionHints` to NOT include `I:import` or `/:index` (those moved to History).

Update spinner display:
```tsx
{loading ? (
  <Text color="yellow"><Spinner type="dots" /></Text>
) : (
  <Text bold>{` ${sessions.length} sessions`}</Text>
)}
```

- [ ] **Step 2: Commit**

```bash
git commit -am "refactor: StatusBar — panel-aware hints, spinner icon only, no label"
```

---

### Task 2: Remove inline hints from all tabs

**Files:**
- Modify: `packages/tui/tabs/HistoryTab.tsx`
- Modify: `packages/tui/tabs/SessionsTab.tsx`
- Modify: `packages/tui/tabs/ComputeTab.tsx`

- [ ] **Step 1: HistoryTab — remove "Enter to import into Ark" from detail pane**

In `HistoryDetail`, remove:
```tsx
<Text dimColor>Enter to import into Ark</Text>
```

- [ ] **Step 2: SessionsTab — remove inline hints from overlays**

Search for "Enter to confirm", "Esc to cancel", "Enter to create", "Esc to go back" in SessionsTab.tsx and remove those `<Text>` elements.

Look for patterns like:
```tsx
<Text dimColor>{"  Enter to confirm, Esc to cancel"}</Text>
```
Remove all of them — the status bar handles this via the `overlay` prop.

- [ ] **Step 3: ComputeTab — check for inline hints**

Scan for any inline hint text and remove.

- [ ] **Step 4: Commit**

```bash
git commit -am "refactor: remove all inline hints from tab panels — status bar is the single source"
```

---

### Task 3: Pass overlay state from App.tsx to StatusBar

**Files:**
- Modify: `packages/tui/App.tsx`
- Modify: `packages/tui/tabs/SessionsTab.tsx` (expose overlay state)

The StatusBar needs to know which overlay is active. Options:

**Option A (simple):** SessionsTab already has `hasOverlay` and the specific mode booleans. Lift the overlay name up to App via a callback.

**Option B (simpler):** Add an `overlay` prop that App.tsx derives from `showForm` + a new state from SessionsTab.

Simplest: App.tsx already knows about `showForm`. For SessionsTab overlays (move, talk, group, inbox, clone), add an `onOverlayChange` callback:

```tsx
// SessionsTab calls this whenever an overlay opens/closes
onOverlayChange?: (overlay: string | null) => void;
```

In App.tsx:
```tsx
const [activeOverlay, setActiveOverlay] = useState<string | null>(null);

// Derive overlay for StatusBar
const overlay = showForm ? "form" : activeOverlay;

<StatusBar ... overlay={overlay} />
<SessionsTab ... onOverlayChange={setActiveOverlay} />
```

In SessionsTab, call `onOverlayChange` whenever overlay state changes:
```tsx
useEffect(() => {
  const overlay = moveMode ? "move" : talkMode ? "talk" : groupMode ? "group" : inboxMode ? "inbox" : cloneMode ? "clone" : null;
  onOverlayChange?.(overlay);
}, [moveMode, talkMode, groupMode, inboxMode, cloneMode]);
```

For HistoryTab, pass search mode:
```tsx
useEffect(() => {
  onOverlayChange?.(mode === "search" ? "search" : null);
}, [mode]);
```

- [ ] **Step 1: Add overlay callback to SessionsTab and HistoryTab**

- [ ] **Step 2: Wire in App.tsx**

- [ ] **Step 3: Pass overlay to StatusBar**

- [ ] **Step 4: Commit**

```bash
git commit -am "feat: pass overlay state to StatusBar for context-aware hints"
```

---

### Task 4: Fix History conversation preview — show more messages

**Files:**
- Modify: `packages/tui/tabs/HistoryTab.tsx`

The conversation preview currently shows last 10 messages from the last 40 lines of the transcript. But many sessions show only 3 messages because the transcript has lots of tool_use entries mixed in.

Fix: scan more lines (last 200) and keep extracting user/assistant messages until we have 15-20.

- [ ] **Step 1: Update conversation preview loading**

Change:
```ts
const recent = lines.slice(-40);
```
To:
```ts
const recent = lines.slice(-200);
```

And change the final slice:
```ts
setConversationPreview(msgs.slice(-15));
```

- [ ] **Step 2: Commit**

```bash
git commit -am "fix: History conversation preview — scan more lines, show 15 messages"
```

---

### Task 5: Update CLAUDE.md + push

- [ ] **Step 1: Add design system rule to CLAUDE.md**

Under TUI Async Rules, add:

```markdown
## TUI Design System

**Status bar = single source of truth for shortcuts.** Hints update based on active tab + pane + overlay. No shortcut text inside panels, overlays, or forms.

**Spinners:**
- Status bar: icon only (no label) — signals "system is busy"
- Panel: detailed progress text ("Indexing... 50 files") — shows what's happening

**Overlay hints:** When a form/overlay is active, status bar shows form controls (Enter:confirm Esc:cancel) instead of tab hints.
```

- [ ] **Step 2: Commit and push**

```bash
git add -A && git commit -m "docs: add TUI design system rules to CLAUDE.md" && git push
```
