# Tab Restructure + History Tab — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reorganize TUI tabs from `Sessions|Compute|Agents|Flows|Recipes` to `Sessions|Agents|Tools|Flows|History|Compute`, adding a History tab for Claude sessions, search, and transcripts.

**Architecture:** Update TabBar type and ordering, rename "Recipes" → "Tools", create a new HistoryTab component, move `I` (Claude import) and `/` (index) from SessionsTab to HistoryTab, update App.tsx tab routing and number key mappings.

**Tech Stack:** Ink (React TUI), existing components (SplitPane, TreeList, useListNavigation)

---

## File Structure

| File | Change |
|------|--------|
| `packages/tui/components/TabBar.tsx` | **Modify:** Update Tab type, TABS order, TAB_KEYS |
| `packages/tui/App.tsx` | **Modify:** Update number key routing, add HistoryTab, remove Recipes placeholder |
| `packages/tui/tabs/HistoryTab.tsx` | **Create:** Claude sessions browser + search + index |
| `packages/tui/tabs/SessionsTab.tsx` | **Modify:** Remove `I` and `/` key handlers + Claude import overlay |
| `packages/tui/components/StatusBar.tsx` | **Modify:** Update hints — remove `I`/`/` from sessions, add history hints |

---

### Task 1: Update TabBar — new tab type and ordering

**Files:**
- Modify: `packages/tui/components/TabBar.tsx`

- [ ] **Step 1: Update TabBar.tsx**

Replace the entire Tab type, TABS array, and TAB_KEYS:

```ts
export type Tab = "sessions" | "agents" | "tools" | "flows" | "history" | "compute";

export const TABS: Tab[] = ["sessions", "agents", "tools", "flows", "history", "compute"];

const TAB_KEYS: Record<Tab, string> = {
  sessions: "1",
  agents: "2",
  tools: "3",
  flows: "4",
  history: "5",
  compute: "6",
};
```

- [ ] **Step 2: Commit**

```bash
git add packages/tui/components/TabBar.tsx
git commit -m "refactor: reorder tabs — Sessions|Agents|Tools|Flows|History|Compute"
```

---

### Task 2: Create HistoryTab — Claude sessions + search + index

**Files:**
- Create: `packages/tui/tabs/HistoryTab.tsx`

- [ ] **Step 1: Create HistoryTab**

The History tab has two modes:
- **Browse** (default) — list Claude sessions, navigate with j/k, Enter to import
- **Search** — type a query, see results from FTS5 + SQLite

```tsx
import React, { useState, useMemo, useEffect } from "react";
import { Box, Text, useInput } from "ink";
import Spinner from "ink-spinner";
import * as core from "../../core/index.js";
import { SplitPane } from "../components/SplitPane.js";
import { useListNavigation } from "../hooks/useListNavigation.js";
import { useStatusMessage } from "../hooks/useStatusMessage.js";
import { SectionHeader } from "../components/SectionHeader.js";
import type { AsyncState } from "../hooks/useAsync.js";
import type { StoreData } from "../hooks/useStore.js";

interface HistoryTabProps extends StoreData {
  pane: "left" | "right";
  async: AsyncState;
}

export function HistoryTab({ pane, async: asyncState, refresh }: HistoryTabProps) {
  const status = useStatusMessage();
  const [mode, setMode] = useState<"browse" | "search">("browse");
  const [claudeSessions, setClaudeSessions] = useState<core.ClaudeSession[]>([]);
  const [searchResults, setSearchResults] = useState<core.SearchResult[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [loading, setLoading] = useState(false);

  // Load Claude sessions on mount
  useEffect(() => {
    asyncState.run("Loading Claude sessions...", async () => {
      const sessions = core.listClaudeSessions({ limit: 50 });
      setClaudeSessions(sessions);
    });
  }, []);

  const items = mode === "browse" ? claudeSessions : searchResults;
  const { sel } = useListNavigation(items.length, { active: pane === "left" });

  useInput((input, key) => {
    if (pane !== "left") return;

    // Rebuild search index
    if (input === "/") {
      asyncState.run("Indexing transcripts...", async () => {
        const count = await core.indexTranscripts({
          onProgress: (indexed, files) => {
            status.show(`Indexing... ${files} files, ${indexed} entries`);
          },
        });
        status.show(`Indexed ${count} transcript entries`);
      });
      return;
    }

    // Toggle search mode
    if (input === "s") {
      setMode(m => m === "search" ? "browse" : "search");
      return;
    }

    // Reload Claude sessions
    if (input === "r") {
      asyncState.run("Refreshing...", async () => {
        const sessions = core.listClaudeSessions({ limit: 50 });
        setClaudeSessions(sessions);
      });
      return;
    }

    // Import selected Claude session
    if (key.return && mode === "browse") {
      const selected = claudeSessions[sel];
      if (!selected) return;
      asyncState.run("Importing session...", () => {
        const s = core.startSession({
          summary: selected.summary?.slice(0, 100) || `Import ${selected.sessionId.slice(0, 8)}`,
          repo: selected.project,
          workdir: selected.project,
          flow: "bare",
        });
        core.updateSession(s.id, { claude_session_id: selected.sessionId });
        status.show(`Imported ${selected.sessionId.slice(0, 8)}`);
        refresh();
      });
      return;
    }
  });

  const selectedItem = items[sel];
  const selectedClaude = mode === "browse" ? claudeSessions[sel] : null;

  return (
    <SplitPane
      focus={pane}
      leftTitle={mode === "browse" ? "Claude Sessions" : "Search Results"}
      rightTitle="Details"
      left={
        <Box flexDirection="column">
          {status.message && <Text color="yellow">{status.message}</Text>}
          {items.length === 0 ? (
            <Text dimColor>{mode === "browse" ? "  No Claude sessions found. Press 'r' to refresh." : "  No results. Press 's' to switch to browse."}</Text>
          ) : (
            items.map((item, idx) => {
              const marker = idx === sel ? ">" : " ";
              if (mode === "browse") {
                const cs = item as core.ClaudeSession;
                const date = (cs.lastActivity || cs.timestamp || "").slice(0, 10);
                const proj = cs.project.split("/").slice(-2).join("/");
                const summary = cs.summary?.slice(0, 50) || "(no summary)";
                return (
                  <Text key={cs.sessionId}>
                    {`${marker} ${cs.sessionId.slice(0, 8)}  ${date}  ${proj.padEnd(20)}  ${summary}`}
                  </Text>
                );
              } else {
                const sr = item as core.SearchResult;
                const match = sr.match?.slice(0, 60) || "";
                return (
                  <Text key={`${sr.sessionId}-${idx}`}>
                    {`${marker} [${sr.source}]  ${sr.sessionId.slice(0, 8)}  ${match}`}
                  </Text>
                );
              }
            })
          )}
        </Box>
      }
      right={
        selectedClaude ? (
          <Box flexDirection="column" paddingX={1}>
            <SectionHeader title="Claude Session" />
            <Text>{`  ID:       ${selectedClaude.sessionId}`}</Text>
            <Text>{`  Project:  ${selectedClaude.project}`}</Text>
            <Text>{`  Messages: ${selectedClaude.messageCount}`}</Text>
            <Text>{`  Started:  ${selectedClaude.timestamp?.slice(0, 19) || "?"}`}</Text>
            <Text>{`  Last:     ${selectedClaude.lastActivity?.slice(0, 19) || "?"}`}</Text>
            {selectedClaude.summary && (
              <>
                <Text> </Text>
                <SectionHeader title="Summary" />
                <Text wrap="wrap">{`  ${selectedClaude.summary}`}</Text>
              </>
            )}
            <Text> </Text>
            <Text dimColor>{"  Press Enter to import into Ark"}</Text>
          </Box>
        ) : (
          <Text dimColor>{"  Select a session to view details"}</Text>
        )
      }
    />
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/tui/tabs/HistoryTab.tsx
git commit -m "feat: add HistoryTab — Claude sessions browser with import + search + index"
```

---

### Task 3: Update App.tsx — route to new tabs

**Files:**
- Modify: `packages/tui/App.tsx`

- [ ] **Step 1: Add HistoryTab import**

Add at the top with the other tab imports:
```ts
import { HistoryTab } from "./tabs/HistoryTab.js";
```

- [ ] **Step 2: Update number key routing**

Replace the number key handlers in `useInput`:

```ts
    } else if (input === "1") {
      switchTab("sessions");
    } else if (input === "2") {
      switchTab("agents");
    } else if (input === "3") {
      switchTab("tools");
    } else if (input === "4") {
      switchTab("flows");
    } else if (input === "5") {
      switchTab("history");
    } else if (input === "6") {
      switchTab("compute");
    }
```

- [ ] **Step 3: Update tab rendering**

Replace the tab conditional rendering block. Key changes:
- Agents moves to position 2
- Tools (formerly Recipes) at position 3 — keep the "coming soon" placeholder for now
- Flows at position 4
- History at position 5 — renders `<HistoryTab>`
- Compute moves to position 6

```tsx
      {tab === "sessions" ? (
        <SessionsTab
          {...store}
          pane={pane}
          async={asyncState}
          onShowForm={() => setShowForm("session")}
          onSelectionChange={setSelectedSession}
          onInputActive={setChildInputActive}
          formOverlay={showForm === "session" ? (
            <NewSessionForm
              store={store}
              async={asyncState}
              onDone={() => setShowForm(null)}
            />
          ) : undefined}
        />
      ) : tab === "agents" ? (
        <AgentsTab {...store} pane={pane} />
      ) : tab === "tools" ? (
        <Box flexGrow={1} justifyContent="center" alignItems="center">
          <Text dimColor>{"Tools — coming soon (recipes, skills, prompt templates)"}</Text>
        </Box>
      ) : tab === "flows" ? (
        <FlowsTab {...store} pane={pane} />
      ) : tab === "history" ? (
        <HistoryTab {...store} pane={pane} async={asyncState} />
      ) : tab === "compute" ? (
        <ComputeTab
          {...store}
          pane={pane}
          async={asyncState}
          onShowForm={() => setShowForm("compute")}
          formOverlay={showForm === "compute" ? (
            <NewComputeForm async={asyncState} onDone={() => setShowForm(null)} />
          ) : undefined}
        />
      ) : null}
```

- [ ] **Step 4: Commit**

```bash
git add packages/tui/App.tsx
git commit -m "feat: route new tab order — Sessions|Agents|Tools|Flows|History|Compute"
```

---

### Task 4: Clean up SessionsTab — remove I and / handlers

**Files:**
- Modify: `packages/tui/tabs/SessionsTab.tsx`

- [ ] **Step 1: Remove Claude import state and handlers**

Remove from SessionsTab.tsx:
1. The `claudeImportMode`, `claudeSessions`, `claudeSelectedIdx` state declarations
2. The `if (input === "I") { ... }` handler block in the main useInput
3. The `if (input === "/") { ... }` handler block in the main useInput
4. The entire `claudeImportMode` useInput handler (j/k/Enter/Esc for the picker)
5. The `claudeImportMode` from the `hasOverlay` expression
6. The Claude import overlay JSX (the `claudeImportMode && (...)` block in the render)

- [ ] **Step 2: Run existing tests**

Run: `bun test packages/tui/__tests__/`

- [ ] **Step 3: Commit**

```bash
git add packages/tui/tabs/SessionsTab.tsx
git commit -m "refactor: remove I and / handlers from SessionsTab — moved to HistoryTab"
```

---

### Task 5: Update StatusBar hints

**Files:**
- Modify: `packages/tui/components/StatusBar.tsx`

- [ ] **Step 1: Remove I and / from session hints, add history hints**

In `getSessionHints()`, remove the `I:import` and `/:index` hints:
```ts
  // Remove these two lines:
  hints.push(<KeyHint key="I" k="I" label="import" />);
  hints.push(<KeyHint key="/" k="/" label="index" />);
```

Add a new `getHistoryHints()` function:
```ts
function getHistoryHints(): React.ReactNode[] {
  return [
    <KeyHint key="jk" k="j/k" label="move" />,
    <KeyHint key="enter" k="Enter" label="import" />,
    <KeyHint key="s" k="s" label="search" />,
    <KeyHint key="/" k="/" label="index" />,
    <KeyHint key="r" k="r" label="refresh" />,
    <KeyHint key="q" k="q" label="quit" />,
  ];
}
```

Update the hints selector to include history:
```ts
  const hints = pane === "right" ? getRightPaneHints()
    : tab === "sessions" ? getSessionHints(selectedSession)
    : tab === "compute" ? getComputeHints()
    : tab === "history" ? getHistoryHints()
    : getGenericHints();
```

- [ ] **Step 2: Commit**

```bash
git add packages/tui/components/StatusBar.tsx
git commit -m "feat: update StatusBar hints for new tab structure"
```

---

### Task 6: Update CLAUDE.md — new tab structure

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update TUI Keyboard Shortcuts section**

Update the tab numbering and add History tab shortcuts. Remove `I` and `/` from Sessions tab.

- [ ] **Step 2: Commit and push**

```bash
git add CLAUDE.md
git commit -m "docs: update CLAUDE.md with new tab structure"
git push
```
