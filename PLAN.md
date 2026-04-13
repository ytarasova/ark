# Plan: Move Events Panel to Its Own Tab

## Summary

The EventLog currently sits as a pinned bar at the bottom of every tab in `App.tsx` (between the tab content and the StatusBar), toggled via the `e` key. This wastes 2-3 rows of vertical space on every screen and overloads the global `e` shortcut. Moving events to a dedicated "Events" tab gives it room for richer display (filtering, per-session grouping, detail pane) while reclaiming vertical space for all other tabs.

## Files to Modify/Create

| File | Change |
|------|--------|
| `packages/tui/tabs/EventsTab.tsx` | **Create** -- new tab component with SplitPane: left=event list, right=event detail |
| `packages/tui/components/TabBar.tsx` | Add `"events"` to `Tab` type union and `TABS` array (position 2, between agents and flows) |
| `packages/tui/App.tsx` | Remove `EventLog` import/render, remove `eventLogExpanded` state, remove `e` shortcut handler, add `EventsTab` to the tab switch block |
| `packages/tui/hooks/useEventLog.ts` | Extend `fetchEvents` to support larger limits and optional session filter; add `sessionId` field to `EventLogEntry` |
| `packages/tui/components/EventLog.tsx` | **Delete** -- no longer needed (functionality moves to EventsTab) |
| `packages/tui/helpers/statusBarHints.tsx` | Add `getEventsHints()` export for the new tab |
| `packages/tui/components/HelpOverlay.tsx` | Remove `["e", "Expand events"]` from Tools group; update tab count hint `"1-8"` -> `"1-9"` (or appropriate range) |
| `packages/tui/components/SplitPane.tsx` | Reduce default `outerChrome` from 7 to 5 (EventLog no longer consumes 2 rows) |
| `packages/tui/tabs/SessionsTab.tsx` | Update `outerChrome={7}` -> `outerChrome={5}` |
| `packages/tui/components/DetailPanel.tsx` | Update comment: remove "event log (2)" from chrome calculation |
| `packages/tui/__tests__/useEventLog.test.tsx` | Update tests if `useEventLog` signature changes; add test for session filter |

## Implementation Steps

### Step 1: Extend `useEventLog` hook to support the new tab's needs

**File:** `packages/tui/hooks/useEventLog.ts`

1. Add `sessionId: string` to the `EventLogEntry` interface (lines 12-18) so events can be associated back to their session in the detail pane.
2. Modify `fetchEvents()` (line 24) to always populate the `sessionId` field from `s.id` when building entries at line 35.
3. The hook already accepts `expanded: boolean` which controls the limit (5 vs 30). The EventsTab will call it with `expanded=true`. No signature change needed.

### Step 2: Create `EventsTab` component

**File:** `packages/tui/tabs/EventsTab.tsx` (new)

Pattern: follow `CostsTab.tsx` as the template (SplitPane, left list, right detail, `useListNavigation`).

1. Import `SplitPane`, `useListNavigation`, `useEventLog`, `SectionHeader`, `getTheme`, `GLOBAL_HINTS`.
2. Props: `{ pane: "left" | "right" }`.
3. Left pane: call `useEventLog(true)` to get the full event list. Render each event as a row: `HH:MM  <colored message>  <source>`. Use `useListNavigation` for j/k selection.
4. Right pane (event selected): show full detail -- timestamp, event type, source session, full message text.
5. Right pane (no selection): show an overview -- total event count, breakdown by type (session_created, stage_started, agent_completed, etc.), most recent event timestamp.
6. Export `getEventsHints()` returning `[...GLOBAL_HINTS]`.

### Step 3: Register the new tab in `TabBar.tsx`

**File:** `packages/tui/components/TabBar.tsx`

1. Update the `Tab` type union (line 6) -- add `"events"` after `"agents"`:
   ```ts
   export type Tab = "sessions" | "agents" | "events" | "flows" | "compute" | "history" | "memory" | "tools" | "schedules" | "costs";
   ```
2. Update the `TABS` array (line 8) -- insert `"events"` at index 2:
   ```ts
   export const TABS: Tab[] = ["sessions", "agents", "events", "flows", "compute", "history", "memory", "tools", "schedules", "costs"];
   ```
3. Update `TAB_KEYS` (lines 10-20) -- renumber from events=3 onward:
   ```ts
   const TAB_KEYS: Record<Tab, string> = {
     sessions: "1",
     agents: "2",
     events: "3",
     flows: "4",
     compute: "5",
     history: "6",
     memory: "7",
     tools: "8",
     schedules: "9",
     costs: "",    // No numeric shortcut (>9 tabs)
   };
   ```
4. Update the label rendering (line 35) to hide the key prefix when the key is empty:
   ```ts
   const label = key ? `${key}:${tab.charAt(0).toUpperCase() + tab.slice(1)}` : tab.charAt(0).toUpperCase() + tab.slice(1);
   ```

### Step 4: Wire `EventsTab` into `App.tsx`

**File:** `packages/tui/App.tsx`

1. Remove the `EventLog` import (line 13).
2. Add `import { EventsTab, getEventsHints } from "./tabs/EventsTab.js"`.
3. Remove `eventLogExpanded` state (line 83).
4. Remove the `e` key handler in `useInput` (lines 147-149 -- the `if (input === "e")` block).
5. Remove the `<EventLog expanded={eventLogExpanded} />` JSX (lines 242-244).
6. Add `EventsTab` case in the tab switch block (insert after the `tab === "agents"` case, around line 183):
   ```tsx
   ) : tab === "events" ? (
     <EventsTab pane={pane} />
   ```
7. Add `getEventsHints()` to the hints memo (around line 256):
   ```tsx
   : tab === "events" ? getEventsHints()
   ```

### Step 5: Update `outerChrome` calculations

The EventLog bar consumed 2 rows when collapsed (1 border-top + 1 content). Removing it frees those rows.

1. **`packages/tui/components/SplitPane.tsx`** line 19: change default `outerChrome` from `7` to `5`.
2. **`packages/tui/tabs/SessionsTab.tsx`** line 467: change `outerChrome={7}` to `outerChrome={5}`.
3. **`packages/tui/components/DetailPanel.tsx`** line 17: update comment from `panel title+gap (2) + event log (2) + status bar (1) + padding (1) = 9` to `panel title+gap (2) + status bar (3) = 5`.

### Step 6: Update `HelpOverlay.tsx`

**File:** `packages/tui/components/HelpOverlay.tsx`

1. Remove `["e", "Expand events"]` from the Tools group (line 52).
2. Update `["1-8", "Switch tabs"]` to `["1-9", "Switch tabs"]` in the Navigation group (line 38).

### Step 7: Delete old `EventLog` component

Delete `packages/tui/components/EventLog.tsx`.

### Step 8: Add `getEventsHints()` to `statusBarHints.tsx`

**File:** `packages/tui/helpers/statusBarHints.tsx`

Add at the end of the file:
```tsx
export function getEventsHints(): React.ReactNode[] {
  return [...GLOBAL_HINTS];
}
```

### Step 9: Update tests

1. **`packages/tui/__tests__/useEventLog.test.tsx`**: Add assertion checking that `sessionId` field is populated on each `EventLogEntry` (in the "returns formatted events" test at line 88).
2. Run `make test-file F=packages/tui/__tests__/useEventLog.test.tsx` to verify.
3. Run `make test` to check for full-suite regressions.

## Testing Strategy

1. **Unit tests:**
   - Update `useEventLog.test.tsx` to verify `sessionId` field is populated on each `EventLogEntry`.
   - Existing tests for event ordering, color mapping, truncation, expanded-vs-collapsed limits should continue to pass unchanged.

2. **Manual TUI testing (`make tui`):**
   - Verify the Events tab appears at position 3 (shortcut key `3`).
   - Verify pressing `3` switches to Events tab and shows the event list.
   - Verify j/k navigation works in the event list.
   - Verify selecting an event shows detail in the right pane.
   - Verify the `e` key no longer toggles an event bar on other tabs.
   - Verify all other tabs gained ~2 rows of vertical space (no bottom EventLog bar).
   - Verify tab numbering is correct: 1=Sessions, 2=Agents, 3=Events, 4=Flows, 5=Compute, 6=History, 7=Memory, 8=Tools, 9=Schedules.
   - Verify `?` help overlay reflects updated shortcuts (no `e:expand`, correct tab range).

3. **Regression checks:**
   - `make test` -- full sequential test suite passes.
   - SessionDetail still shows per-session events in its "Events" section (`SessionDetail.tsx` lines 590-608) -- this is independent and must NOT be removed.

## Risk Assessment

1. **Tab numbering shift.** All tabs after "agents" shift by +1. Users with muscle memory for `3`=flows, `4`=compute, etc. will need to relearn. **Mitigation:** The help overlay (`?`) shows the new mapping. This is a one-time change.

2. **`outerChrome` miscalculation.** If the 2-row reduction is wrong, content will overflow or leave gaps. **Mitigation:** The EventLog collapsed state uses `borderStyle="single"` (1 top + 1 bottom border) + 1 content line = 3 rows. But Ink single-border boxes use 2 rows for top/bottom borders. Verify visually in `make tui` at different terminal heights.

3. **Costs tab loses numeric shortcut.** With 10 tabs, costs (position 10) has no `1-9` shortcut. **Mitigation:** Costs is a monitoring tab accessed infrequently. Users can still click/cycle to it.

4. **SessionDetail's inline Events section.** `SessionDetail.tsx` lines 590-608 show per-session events inline. This must NOT be removed -- it's contextual to the selected session. The new Events tab shows cross-session global events. Both serve different purposes.

5. **`e` key freed.** The `e` shortcut currently toggles EventLog globally. Removing it frees `e` for future use. No breakage since the EventLog that consumed it is being deleted.

6. **`useEventLog` polling.** The hook polls every 5 seconds. In the Events tab (always expanded), this fetches up to 30 events from 15 sessions every 5s. This is the same load as when the EventLog was expanded globally -- no regression.

## Open Questions

1. **Tab position:** Should "Events" go at position 3 (between Agents and Flows, proposed above) or at the end (position 10)? Position 3 is more discoverable but shifts all existing tab shortcuts. Position 10 avoids the shift but has no numeric shortcut.

2. **`e` key reuse:** Should `e` now switch to the Events tab (as a mnemonic shortcut, like `3`), or should it remain unbound for future use?

3. **Event filtering in the new tab:** Should the Events tab support filtering by session, event type, or time range? This plan does not include filtering -- it can be added as a follow-up once the tab exists.

4. **Costs tab access:** With costs losing its numeric shortcut, should we consider an alternative ordering or tab consolidation? For example, merging Costs into a combined "Observability" tab with Events.
