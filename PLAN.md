# Plan: Fix TUI Session Detail Pane - Remove Duplicate Duration Display

## Summary

The session detail pane in `SessionDetail.tsx` shows duration information twice: once as a parenthetical on the "Created" row (`(5m 30s ago)` via `formatDuration(s.created_at)`) and again on a dedicated "Duration" row. For running/waiting sessions both values are identical. For terminal sessions the parenthetical shows time-since-creation-to-now which is misleading vs the Duration row's start-to-end time. Fix: remove the parenthetical duration from the "Created" row, keeping only the dedicated "Duration" row.

## Files to modify/create

1. **`packages/tui/tabs/SessionDetail.tsx`** (line 365) -- Remove `{" "}<Text dimColor>({formatDuration(s.created_at)} ago)</Text>` from the Created KeyValue row

## Implementation steps

1. **Edit `packages/tui/tabs/SessionDetail.tsx` line 365** -- Change the Created row from:
   ```tsx
   <KeyValue label="Created">{hms(s.created_at)}{" "}<Text dimColor>({formatDuration(s.created_at)} ago)</Text></KeyValue>
   ```
   to:
   ```tsx
   <KeyValue label="Created">{hms(s.created_at)}</KeyValue>
   ```
   This removes the duplicate duration display while preserving the HH:MM:SS timestamp.

2. **Check if `formatDuration` import is still needed** -- Yes, it is still used on lines 367 and 370 for the Duration rows. No import cleanup needed.

3. **Verify build** -- Run `npx tsc --noEmit` to confirm no type errors.

## Testing strategy

- **Visual verification**: Run `make tui`, select a running session, confirm "Created" shows only the timestamp (e.g. `10:30:45`) without the parenthetical duration. Confirm the "Duration" row still displays correctly for running, completed, and stopped sessions.
- **Existing tests**: Run `make test-file F=packages/tui/__tests__/sessionFormatting.test.ts` to confirm no regressions in formatting helpers (this change is purely in the JSX template, not in helper functions).
- No new unit tests needed -- this is a one-line template change removing redundant display.

## Risk assessment

- **Very low risk** -- Single-line JSX change removing redundant text. No logic changes, no helper changes, no data flow changes.
- **No breaking changes** -- No APIs or types are modified.
- **Edge case**: Sessions with `created_at = null` -- `hms()` already handles null gracefully (returns `""`), unchanged behavior.

## Open questions

None -- the fix is straightforward.
