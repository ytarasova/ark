# Ink TUI Rewrite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the neo-blessed TUI with Ink (React) to fix the Setulc terminfo crash and get a modern, maintainable component-based terminal UI.

**Architecture:** Each TUI screen becomes a React component. State is managed via React hooks (useState/useEffect) reading from the existing SQLite store. Key bindings use Ink's useInput hook. The split-pane layout uses Ink's Box with flexbox. Forms use ink-select-input for dropdowns. The existing packages/core and packages/compute modules are unchanged - only packages/tui is rewritten.

**Tech Stack:** TypeScript, React 19, Ink 6, ink-select-input, ink-spinner, ink-text-input

**Depends on:** Existing core/compute packages (unchanged)

**Note:** The old blessed TUI files in packages/tui/ will be deleted and replaced. Reusable logic (state refresh, helpers, constants, async utilities) is preserved and adapted.

---

## File Structure

### Delete (old blessed TUI)

All files in `packages/tui/` except these reusable modules:
- `constants.ts` - ICON/COLOR maps (keep, adapt)
- `helpers.ts` - ago(), hms(), bar(), generateName(), getAwsProfiles() (keep, adapt)
- `async.ts` - runAsync, runSafe, showError (delete - React handles this differently)
- `state.ts` - refresh, selectedSession, selectedHost (keep as data layer)

### New files

| File | Responsibility |
|------|---------------|
| `packages/tui/index.tsx` | Entry point - render `<App />` |
| `packages/tui/App.tsx` | Root component - tab bar, split panes, status bar, key bindings |
| `packages/tui/hooks/useStore.ts` | Hook wrapping state.ts - auto-refresh on interval, returns sessions/hosts/agents/pipelines |
| `packages/tui/hooks/useHostMetrics.ts` | Hook for polling host metrics via compute providers |
| `packages/tui/hooks/useAsync.ts` | Hook for running async ops with status feedback |
| `packages/tui/components/TabBar.tsx` | Tab bar component |
| `packages/tui/components/StatusBar.tsx` | Bottom status bar with context-sensitive key hints |
| `packages/tui/components/SplitPane.tsx` | Left list + right detail layout |
| `packages/tui/components/SelectMenu.tsx` | Reusable dropdown/select menu (replaces blessed.list) |
| `packages/tui/components/MetricBar.tsx` | CPU/MEM/DISK bar with color thresholds |
| `packages/tui/components/SectionHeader.tsx` | Styled section header |
| `packages/tui/tabs/SessionsTab.tsx` | Sessions list + detail |
| `packages/tui/tabs/HostsTab.tsx` | Hosts list + detail + activity log |
| `packages/tui/tabs/AgentsTab.tsx` | Agents list + detail |
| `packages/tui/tabs/PipelinesTab.tsx` | Pipelines list + detail |
| `packages/tui/forms/NewSessionForm.tsx` | Session creation form with dropdowns |
| `packages/tui/forms/NewHostForm.tsx` | Host creation form with dropdowns |

---

## Task 1: Install dependencies and create entry point

**Files:**
- Modify: `package.json` (add ink-text-input, ink-select-input)
- Create: `packages/tui/index.tsx`
- Create: `packages/tui/App.tsx`

- [ ] **Step 1: Install Ink ecosystem packages**

```bash
cd /Users/yana/Projects/ark && bun add ink-text-input ink-select-input
```

- [ ] **Step 2: Create entry point**

Create `packages/tui/index.tsx`:
```tsx
#!/usr/bin/env bun
import React from "react";
import { render } from "ink";
import { App } from "./App.js";

render(<App />);
```

- [ ] **Step 3: Create minimal App shell**

Create `packages/tui/App.tsx`:
```tsx
import React, { useState } from "react";
import { Box, Text, useInput, useApp } from "ink";

type Tab = "sessions" | "agents" | "pipelines" | "recipes" | "hosts";
const TABS: Tab[] = ["sessions", "agents", "pipelines", "recipes", "hosts"];

export function App() {
  const { exit } = useApp();
  const [tab, setTab] = useState<Tab>("sessions");

  useInput((input, key) => {
    if (input === "q" || (input === "c" && key.ctrl)) exit();
    if (input === "1") setTab("sessions");
    if (input === "2") setTab("agents");
    if (input === "3") setTab("pipelines");
    if (input === "4") setTab("recipes");
    if (input === "5") setTab("hosts");
    if (key.tab) {
      const idx = TABS.indexOf(tab);
      setTab(TABS[(idx + 1) % TABS.length]);
    }
  });

  return (
    <Box flexDirection="column" width="100%" height="100%">
      <Box>
        {TABS.map((t, i) => (
          <Text key={t} bold={t === tab} color={t === tab ? "white" : "gray"}>
            {" "}{i + 1}:{t.charAt(0).toUpperCase() + t.slice(1)}{" "}
          </Text>
        ))}
      </Box>
      <Box flexGrow={1}>
        <Text>Tab: {tab}</Text>
      </Box>
      <Box>
        <Text dimColor>q:quit  1-5:tabs  Tab:cycle</Text>
      </Box>
    </Box>
  );
}
```

- [ ] **Step 4: Test it runs**

```bash
bun run packages/tui/index.tsx
```
Expected: Shows tab bar, responds to 1-5 keys, q to quit

- [ ] **Step 5: Update CLI to use new entry point**

The CLI already imports `../tui/index.js` which will resolve to `index.tsx` via Bun.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat: Ink TUI shell - entry point, App with tab bar and key bindings"
```

---

## Task 2: Data hooks (useStore, useHostMetrics, useAsync)

**Files:**
- Keep/adapt: `packages/tui/state.ts` (rename to `packages/tui/data.ts`)
- Create: `packages/tui/hooks/useStore.ts`
- Create: `packages/tui/hooks/useHostMetrics.ts`
- Create: `packages/tui/hooks/useAsync.ts`

- [ ] **Step 1: Create useStore hook**

Create `packages/tui/hooks/useStore.ts`:
```tsx
import { useState, useEffect } from "react";
import * as core from "../../core/index.js";
import type { Host, Session } from "../../core/store.js";

export function useStore(refreshMs = 3000) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [hosts, setHosts] = useState<Host[]>([]);
  const [agents, setAgents] = useState<ReturnType<typeof core.listAgents>>([]);
  const [pipelines, setPipelines] = useState<ReturnType<typeof core.listPipelines>>([]);

  useEffect(() => {
    const refresh = () => {
      try {
        setSessions(core.listSessions({ limit: 50 }));
        setHosts(core.listHosts());
        setAgents(core.listAgents());
        setPipelines(core.listPipelines());
      } catch { /* SQLite locked */ }
    };
    refresh();
    const timer = setInterval(refresh, refreshMs);
    return () => clearInterval(timer);
  }, [refreshMs]);

  return { sessions, hosts, agents, pipelines };
}
```

- [ ] **Step 2: Create useHostMetrics hook**

Create `packages/tui/hooks/useHostMetrics.ts`:
```tsx
import { useState, useEffect, useRef } from "react";
import { getProvider } from "../../compute/index.js";
import type { Host } from "../../core/store.js";
import type { HostSnapshot } from "../../compute/types.js";

export function useHostMetrics(hosts: Host[], active: boolean, pollMs = 10000) {
  const [snapshots, setSnapshots] = useState<Map<string, HostSnapshot>>(new Map());
  const polling = useRef(false);

  useEffect(() => {
    if (!active) return;
    const poll = async () => {
      if (polling.current) return;
      polling.current = true;
      try {
        const next = new Map(snapshots);
        for (const h of hosts) {
          if (h.status !== "running") continue;
          const provider = getProvider(h.provider);
          if (!provider) continue;
          try {
            const snap = await provider.getMetrics(h);
            next.set(h.name, snap);
          } catch { /* host unreachable */ }
        }
        setSnapshots(next);
      } finally { polling.current = false; }
    };
    poll();
    const timer = setInterval(poll, pollMs);
    return () => clearInterval(timer);
  }, [hosts, active, pollMs]);

  return snapshots;
}
```

- [ ] **Step 3: Create useAsync hook**

Create `packages/tui/hooks/useAsync.ts`:
```tsx
import { useState, useCallback } from "react";

interface AsyncState {
  loading: boolean;
  error: string | null;
  label: string | null;
}

export function useAsync() {
  const [state, setState] = useState<AsyncState>({ loading: false, error: null, label: null });

  const run = useCallback(async (label: string, action: () => Promise<void>) => {
    setState({ loading: true, error: null, label });
    try {
      await action();
      setState({ loading: false, error: null, label: null });
    } catch (e: any) {
      setState({ loading: false, error: e?.message ?? String(e), label });
    }
  }, []);

  const clearError = useCallback(() => {
    setState(s => ({ ...s, error: null }));
  }, []);

  return { ...state, run, clearError };
}
```

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat: data hooks - useStore, useHostMetrics, useAsync"
```

---

## Task 3: Shared components (SplitPane, MetricBar, SectionHeader, StatusBar, TabBar, SelectMenu)

**Files:**
- Create: `packages/tui/components/TabBar.tsx`
- Create: `packages/tui/components/StatusBar.tsx`
- Create: `packages/tui/components/SplitPane.tsx`
- Create: `packages/tui/components/MetricBar.tsx`
- Create: `packages/tui/components/SectionHeader.tsx`
- Create: `packages/tui/components/SelectMenu.tsx`

- [ ] **Step 1: Create all shared components**

These are small, focused React components. Each renders using Ink's Box/Text.

`TabBar.tsx` - renders tab names with active highlight
`StatusBar.tsx` - bottom bar with key hints and status message
`SplitPane.tsx` - flexbox layout with left (40%) and right (60%) panes
`MetricBar.tsx` - colored progress bar (green/yellow/red by threshold)
`SectionHeader.tsx` - bold inverse section title
`SelectMenu.tsx` - wrapper around ink-select-input with label/value support

- [ ] **Step 2: Wire TabBar and StatusBar into App.tsx**

Replace the inline tab bar in App.tsx with the TabBar component. Add StatusBar at the bottom.

- [ ] **Step 3: Verify rendering**

```bash
bun run packages/tui/index.tsx
```

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat: shared Ink components - TabBar, StatusBar, SplitPane, MetricBar, SectionHeader, SelectMenu"
```

---

## Task 4: Sessions tab

**Files:**
- Create: `packages/tui/tabs/SessionsTab.tsx`
- Modify: `packages/tui/App.tsx` (wire in)

- [ ] **Step 1: Create SessionsTab**

Port the sessions list and detail from the old blessed renderer:
- Left pane: session list with status icons, summary, stage, age
- Right pane: session header, pipeline bar, info fields, channel status, agent output, events
- Key bindings: j/k navigate, Enter dispatch, a attach, s stop, r resume, c complete, x delete, n new

Use `useInput` for key bindings, `useStore` for data.
For attach: use `useApp().exit()` then `execFileSync("tmux", ["attach", ...])` - no screen.destroy needed.

- [ ] **Step 2: Wire into App.tsx**

```tsx
{tab === "sessions" && <SessionsTab store={store} async={async} />}
```

- [ ] **Step 3: Test**

```bash
bun run packages/tui/index.tsx
```
Verify sessions display, j/k works, Enter dispatches.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat: Sessions tab in Ink"
```

---

## Task 5: Hosts tab

**Files:**
- Create: `packages/tui/tabs/HostsTab.tsx`
- Modify: `packages/tui/App.tsx`

- [ ] **Step 1: Create HostsTab**

Port the hosts list, detail with metrics, activity log:
- Left pane: host list with status indicator, name, provider, IP
- Right pane: metrics bars (MetricBar), network, uptime, sessions table, processes, docker, ports, cost, activity log
- Key bindings: j/k, Enter provision, s start/stop, e edit, x delete, n new, a ssh
- Activity log: stored as React state, appended to via provision callbacks

- [ ] **Step 2: Wire into App.tsx**

- [ ] **Step 3: Test with existing hosts**

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat: Hosts tab in Ink with metrics and activity log"
```

---

## Task 6: Agents and Pipelines tabs

**Files:**
- Create: `packages/tui/tabs/AgentsTab.tsx`
- Create: `packages/tui/tabs/PipelinesTab.tsx`
- Modify: `packages/tui/App.tsx`

- [ ] **Step 1: Create AgentsTab**

Simple list + detail. Left: agent name, model, tool/skill counts. Right: full config dump.

- [ ] **Step 2: Create PipelinesTab**

Simple list + detail. Left: pipeline name, stage chain. Right: stage details with gates.

- [ ] **Step 3: Wire into App.tsx, test**

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat: Agents and Pipelines tabs in Ink"
```

---

## Task 7: Forms (NewSession, NewHost)

**Files:**
- Create: `packages/tui/forms/NewSessionForm.tsx`
- Create: `packages/tui/forms/NewHostForm.tsx`

- [ ] **Step 1: Create NewSessionForm**

Multi-step form using useState for wizard state:
1. Text input: summary
2. Text input: repo path
3. SelectMenu: compute host (local + all hosts)
4. SelectMenu: pipeline

On submit: calls core.startSession + dispatches.

- [ ] **Step 2: Create NewHostForm**

Multi-step form:
1. Text input: name (default: generateName())
2. SelectMenu: provider (ec2, local, docker)
3. If ec2: SelectMenu for size, arch, region, profile (with label/value items)

On submit: calls core.createHost.

- [ ] **Step 3: Wire into tabs via "n" key binding**

When user presses "n" on Sessions/Hosts tab, show the form as an overlay.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat: NewSession and NewHost forms in Ink"
```

---

## Task 8: Delete old blessed TUI and cleanup

**Files:**
- Delete: all old blessed files (layout.ts, render/*, actions/*, forms/select.ts, forms/prompt.ts, polling.ts, async.ts)
- Keep: `constants.ts`, `helpers.ts` (imported by new components)
- Modify: `state.ts` (keep as data module, remove blessed-specific code)

- [ ] **Step 1: Delete old files**

```bash
rm -rf packages/tui/layout.ts packages/tui/render packages/tui/actions packages/tui/forms/select.ts packages/tui/forms/prompt.ts packages/tui/polling.ts packages/tui/async.ts
```

- [ ] **Step 2: Clean up state.ts**

Remove `addHostLog`, `hostLogs`, `hostSnapshots` from state.ts - these are now React state in HostsTab.
Keep: `refresh()`, `selectedSession()`, `selectedHost()`, `TABS` constant.

- [ ] **Step 3: Remove neo-blessed dependency**

```bash
# Don't remove yet - check if anything else imports it
grep -r "neo-blessed" packages/ --include="*.ts" --include="*.tsx"
```

If only old files reference it:
```bash
bun remove neo-blessed
```

- [ ] **Step 4: Run tests, verify everything works**

```bash
bun test
bun run packages/tui/index.tsx
```

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "refactor: remove neo-blessed TUI, clean up dead code"
```

---

## Task 9: Integration testing

- [ ] **Step 1: Test full TUI flow**

```bash
ark tui
```

Verify:
- Tab switching (1-5, Tab)
- Sessions: list, dispatch (Enter), attach (a), stop (s), create (n)
- Hosts: list, create (n), provision (Enter), metrics display, SSH (a)
- Agents: list + detail
- Pipelines: list + detail
- Scrolling in detail panes
- Error display in status bar
- No crashes on attach/detach

- [ ] **Step 2: Fix any issues found**

- [ ] **Step 3: Final commit**

```bash
git add -A && git commit -m "feat: complete Ink TUI rewrite - replace neo-blessed"
```

---

## Summary

| Task | What | Files |
|------|------|-------|
| 1 | Entry point + App shell | `index.tsx`, `App.tsx` |
| 2 | Data hooks | `hooks/useStore.ts`, `useHostMetrics.ts`, `useAsync.ts` |
| 3 | Shared components | `components/TabBar.tsx`, `StatusBar.tsx`, `SplitPane.tsx`, `MetricBar.tsx`, `SectionHeader.tsx`, `SelectMenu.tsx` |
| 4 | Sessions tab | `tabs/SessionsTab.tsx` |
| 5 | Hosts tab | `tabs/HostsTab.tsx` |
| 6 | Agents + Pipelines tabs | `tabs/AgentsTab.tsx`, `PipelinesTab.tsx` |
| 7 | Forms | `forms/NewSessionForm.tsx`, `NewHostForm.tsx` |
| 8 | Delete old blessed TUI | cleanup |
| 9 | Integration testing | verification |
