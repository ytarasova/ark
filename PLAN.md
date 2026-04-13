# Plan: Rewrite TreeList as a proper tree component

## Summary

TreeList currently builds a flat `rows: ReactNode[]` array during render, mixing group headers, items, and child decorations into a single list. Selection is index-based (`sel: number` into `items[]`), forcing every caller to pre-sort items to match TreeList's internal group order and manually wire `useListNavigation`. This rewrite makes TreeList a self-contained tree component: it owns navigation (j/k/f/b/g/G), uses key-based selection (`selectedKey`/`onSelect`), builds an internal `TreeNode[]` model, and eliminates the pre-sort requirement from all 7 consumers.

## Files to modify/create

| File | Change |
|------|--------|
| `packages/tui/components/TreeList.tsx` | Rewrite: internal tree model, key-based selection, absorb navigation |
| `packages/tui/tabs/SessionsTab.tsx` | Switch from `useListNavigation` + `sel` + pre-sort to `selectedKey`/`onSelect` |
| `packages/tui/tabs/ToolsTab.tsx` | Same migration; remove pre-sort by group label |
| `packages/tui/tabs/ComputeTab.tsx` | Same migration; remove pre-sort by provider |
| `packages/tui/tabs/AgentsTab.tsx` | Same migration; remove pre-sort by role/runtime |
| `packages/tui/tabs/HistoryTab.tsx` | Same migration (flat list, no grouping) |
| `packages/tui/tabs/FlowsTab.tsx` | Same migration (flat list, no grouping) |
| `packages/tui/components/MemoryManager.tsx` | Same migration (flat list, no grouping) |
| `packages/tui/__tests__/TreeList.test.tsx` | Rewrite tests for new API (key-based selection, active navigation) |
| `packages/tui/__tests__/consistency.test.tsx` | Update tests for new TreeList props |
| `packages/tui/hooks/useListNavigation.ts` | **Keep unchanged** -- still used by SessionDetail, SchedulesTab, CostsTab |

## Implementation steps

### Step 1: Rewrite TreeList component (`packages/tui/components/TreeList.tsx`)

Replace the current flat-array-with-index API with a tree-aware component.

**New props interface** (replaces `TreeListProps<T>` at line 7):

```ts
interface TreeListProps<T> {
  items: T[];
  /** Unique identity for each item. Used for stable selection across reorders. */
  getKey: (item: T) => string;
  /** Group items by this key. Ungrouped items go under "" group. */
  groupBy?: (item: T) => string;
  /** Extra group names to show even if they have no items (empty buckets). */
  emptyGroups?: string[];
  /** Custom sort comparator for group keys. */
  groupSort?: (a: string, b: string) => number;
  /** Render a single row as a plain string (for ListRow highlight). */
  renderRow: (item: T, selected: boolean) => string;
  /** Render colored version for unselected rows (optional). */
  renderColoredRow?: (item: T) => React.ReactNode;
  /** Children to render under an item (visual only, not navigable). */
  renderChildren?: (item: T) => React.ReactNode;
  /** Currently selected item key (controlled). null = nothing selected. */
  selectedKey: string | null;
  /** Called when selection changes (j/k navigation or list reorder). */
  onSelect: (item: T | null) => void;
  /** Whether TreeList handles keyboard input (j/k/f/b/g/G). */
  active?: boolean;
  /** Message when list is empty. */
  emptyMessage?: string;
  /** Add blank line between rows. */
  spacing?: boolean;
}
```

**Internal tree model** -- built in `useMemo`:

```ts
type TreeNode<T> =
  | { type: "group"; key: string; label: string; count: number }
  | { type: "item"; key: string; data: T }
  | { type: "empty"; key: string }      // "(empty)" placeholder for empty groups
  | { type: "spacing"; key: string };    // blank line between items
```

**Key behaviors:**

1. Build `TreeNode[]` from items + groupBy + groupSort + emptyGroups (memoized). Store both the full node list and a parallel `selectableItems: T[]` array (items in visual order).
2. Find current selection index within `selectableItems` by matching `selectedKey` against `getKey(item)`.
3. Handle j/k/f/b/g/G via `useInput` when `active` -- compute next item in `selectableItems`, call `onSelect(nextItem)`.
4. When items change and `selectedKey` no longer matches any item, call `onSelect(selectableItems[0] ?? null)` to auto-select first.
5. Render all `TreeNode[]` as React elements, wrapping selected item in `<ListRow selected>`.
6. Compute `followIndex` for ScrollBox based on the selected node's position in the full `TreeNode[]` array (not just selectables), so group headers scroll into view when the first item in a group is selected.

**Navigation absorbed from `useListNavigation`** (lines 27-43 of `useListNavigation.ts`):
- j/downArrow: next selectable item
- k/upArrow: previous selectable item
- f/pageDown: +20 selectable items
- b/pageUp: -20 selectable items
- g: first selectable item
- G: last selectable item

### Step 2: Migrate SessionsTab (`packages/tui/tabs/SessionsTab.tsx`)

This is the most complex consumer -- it uses groupBy, groupSort, renderChildren, emptyGroups, sticky selection, and programmatic `setSel`.

**Changes:**

1. **Remove** `useListNavigation` import and call (line 158). Replace with:
   ```ts
   const [selected, setSelected] = useState<Session | null>(null);
   ```
2. **Remove** sticky selection logic (lines 160-169). Key-based selection handles this automatically -- when `groupByStatus` toggles, the same session key stays selected.
3. **Remove** pre-sort in `topLevel` memo (lines 126-144). TreeList handles ordering via `groupBy`/`groupSort`. Keep only the `parent_id` filter:
   ```ts
   const topLevel = useMemo(() => sessions.filter(s => !s.parent_id), [sessions]);
   ```
4. **Update** TreeList usage (lines 497-552):
   - Remove `sel={sel}`
   - Add `getKey={(s) => s.id}`
   - Add `selectedKey={selected?.id ?? null}`
   - Add `onSelect={setSelected}`
   - Add `active={pane === "left" && !hasOverlay}`
5. **Replace** all `selected` derivation from `filteredTopLevel[sel]` with the `selected` state variable. Currently `selected` is derived around line 170 as `filteredTopLevel[sel]` -- this becomes the state variable.
6. **Replace** `setSel(0)` calls (e.g., line 468) with `setSelected(null)` (TreeList auto-selects first item when selectedKey is null/missing).
7. **Replace** `setSel(idx)` calls (e.g., line 643 in search-to-select) with `setSelected(session)` where `session` is the found item.

### Step 3: Migrate ToolsTab (`packages/tui/tabs/ToolsTab.tsx`)

1. **Remove** `useListNavigation` (line 79). Add `const [selected, setSelected] = useState<ToolEntry | null>(null)`.
2. **Remove** pre-sort logic that sorts items by group label (around lines 67-73).
3. **Update** TreeList: add `getKey`, `selectedKey`, `onSelect`, `active`. Remove `sel`.
4. **Replace** `items[sel]` (line 80) with `selected`.

### Step 4: Migrate ComputeTab (`packages/tui/tabs/ComputeTab.tsx`)

1. **Remove** `useListNavigation` (line 49). Add `const [selected, setSelected] = useState<Compute | null>(null)`.
2. **Remove** `sorted` memo that pre-sorts by provider (lines 44-47). Pass `computes` directly.
3. **Update** TreeList: add `getKey={(h) => h.name}`, `selectedKey`, `onSelect`, `active`. Remove `sel`.
4. **Replace** `sorted[sel]` with `selected`.

### Step 5: Migrate AgentsTab (`packages/tui/tabs/AgentsTab.tsx`)

1. **Remove** `useListNavigation` (line 60). Add `const [selected, setSelected] = useState<ListItem | null>(null)`.
2. **Remove** pre-sort within items memo (lines 51-58) -- just concatenate roles and runtimes unsorted.
3. **Update** TreeList: add `getKey={(i) => i.name}`, `selectedKey`, `onSelect`, `active`. Remove `sel`.
4. **Replace** `items[sel]` with `selected`.

### Step 6: Migrate flat-list consumers (HistoryTab, FlowsTab, MemoryManager)

These are simpler -- no groupBy, no pre-sorting:

**HistoryTab** (`packages/tui/tabs/HistoryTab.tsx`):
1. Remove `useListNavigation`. Add `useState` for selected.
2. Update TreeList with `getKey`, `selectedKey`, `onSelect`, `active`. Remove `sel`.

**FlowsTab** (`packages/tui/tabs/FlowsTab.tsx`):
1. Same pattern.

**MemoryManager** (`packages/tui/components/MemoryManager.tsx`):
1. Same pattern.

### Step 7: Update tests

**`packages/tui/__tests__/TreeList.test.tsx`:**
- All tests need new required props: `getKey`, `selectedKey`, `onSelect`, `active`.
- Replace `sel={N}` with `selectedKey="<key>"`.
- Add tests for:
  - Key-based selection: select by key, verify correct item highlighted.
  - Auto-reselect on reorder: change items order, verify same key stays selected.
  - Auto-select first when selectedKey is null.
  - Navigation: render with `active`, send j/k/g/G via stdin, verify `onSelect` calls.
  - Group headers are not navigable (j skips from last item in group to first item in next group).

**`packages/tui/__tests__/consistency.test.tsx`:**
- Update props from `sel={N}` to `getKey`/`selectedKey`/`onSelect`.

### Step 8: Verify e2e tests still pass

E2e tests in `packages/tui-e2e/` interact with the TUI via terminal I/O. They don't import TreeList directly -- they test rendered output. These should pass without changes as long as:
- `>` prefix still marks selected items
- Group headers still render as `GroupName (N)`
- j/k navigation still works
- Empty groups still show `(empty)`

Run: `make test-file F=packages/tui/__tests__/TreeList.test.tsx` then `make test-file F=packages/tui/__tests__/consistency.test.tsx`.

## Testing strategy

1. **Unit tests** (`TreeList.test.tsx`): Verify tree model construction, key-based selection, auto-select-first, navigation (j/k/f/b/g/G), group ordering, empty groups, renderChildren, spacing. Use `ink-testing-library` + `stdin.write()` for navigation tests.

2. **Consistency tests** (`consistency.test.tsx`): Verify `>` marker, space prefix, flat-list-without-groupBy behavior.

3. **Regression run**: `make test` -- full sequential suite to catch any import or prop mismatches.

4. **E2e smoke**: Run key e2e test files (`tools-tab.pw.ts`, `compute-tab.pw.ts`, `agents-tab.pw.ts`, `flows-tab.pw.ts`, `memory-tab.pw.ts`) to verify grouped-list navigation still works end-to-end.

5. **Manual TUI verification**: `make tui` and test:
   - Sessions tab: j/k through sessions, toggle `%` grouping, verify selection persists across reorder.
   - Compute tab: verify grouped-by-provider rendering with j/k navigation.
   - Tools tab: verify grouped rendering.
   - Agents tab: verify Roles/Runtimes grouping.

## Risk assessment

| Risk | Mitigation |
|------|------------|
| **Prop change breaks consumers not in the list** | Grep for all `TreeList` imports (done -- 7 consumers + 2 test files, all accounted for). |
| **`useListNavigation` removal breaks non-TreeList users** | `useListNavigation` is kept unchanged. Only TreeList consumers stop using it. SessionDetail, SchedulesTab, and CostsTab continue using it directly. |
| **Navigation feels different** | TreeList absorbs the exact same key bindings (j/k/f/b/g/G with PAGE_SIZE=20). No behavior change for users. |
| **`onSelect` fires on mount** | TreeList should auto-select first item and call `onSelect` during initial render effect. Consumers must handle this (they already handle null). |
| **Concurrent `useInput` hooks** | TreeList's `active` prop gates `useInput` the same way `useListNavigation` did -- only one handler processes keys at a time. |
| **ScrollBox followIndex regression** | The new `followIndex` computation maps the selected node's position in the full TreeNode[] array (including headers). Verify group headers scroll into view when first item in group is selected. |
| **E2e test flakiness** | E2e tests don't reference TreeList props directly, only rendered text. Output format is unchanged (`>` prefix, group headers, `(empty)`). Low risk. |

## Open questions

1. **Should `getKey` be required or optional with a fallback?** Making it required is safer (forces callers to think about identity). All 7 consumers have natural keys (session.id, item.name, compute.name, flow.name, etc.). Recommend: required.

2. **Should `renderChildren` nodes become navigable?** The current plan keeps them as visual-only decorations (matching current behavior). Making fork children navigable would require a deeper tree model with parent-child navigation semantics. Recommend: keep visual-only for this PR, add navigable children as a follow-up.

3. **Should groups be collapsible?** A natural extension of the tree model. Not needed now -- no consumer requests it. Recommend: defer.
