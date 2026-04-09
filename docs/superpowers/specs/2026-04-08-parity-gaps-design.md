# Surface Parity Gaps -- Consolidated Design

Close feature gaps between CLI, TUI, and Web UI. CLI is the reference (99% complete). TUI is at 61%, Web at 64%.

## Chunks (independent, ordered by impact)

### Chunk 1: New Session Form Enrichment

**Web gaps**: Missing compute selector, ticket field, agent override, auto-dispatch toggle.
**TUI gaps**: Missing ticket field, recipe selector.

**Web NewSessionModal.tsx changes:**
- Add `compute_name` dropdown (populated from GET /api/compute)
- Add `ticket` text input
- Add `agent` dropdown (populated from GET /api/agents, optional override)
- Add "Dispatch after create" checkbox (calls /api/sessions/:id/dispatch after create)
- Change `flow` from text input to dropdown (populated from GET /api/flows)
- Change `group_name` from text input to dropdown with create-new option (from GET /api/groups)

**TUI NewSessionForm.tsx changes:**
- Add `ticket` text field
- Already has compute, flow as selects -- good

### Chunk 2: Web Search/History

Web has zero search capability. Critical gap.

- Add search input to SessionsPage header (already has placeholder input but only filters local list)
- Add History page (`HistoryView`) -- currently shows "History" heading but no content
- Wire to existing GET /api/search?q= endpoint for session search
- Wire to GET /api/search/global?q= for transcript search
- Show results as clickable session list

### Chunk 3: Todo CRUD

**TUI gap**: Read-only todos display. Need add/toggle/delete.
**Web gap**: Already has todo UI in SessionDetail -- verify it works end-to-end.

**TUI changes:**
- In session detail pane, add todo input (similar to talk overlay)
- Keybinding: 'T' for add todo when in detail pane
- Display todos with toggle/delete support

### Chunk 4: Memory CRUD for TUI

TUI can only list and delete memories. Missing add and recall.

- Add memory creation form (similar to new session form)
- Add recall/search input
- Wire to existing RPC methods

### Chunk 5: Schedule Creation for TUI

TUI can view/enable/disable/delete schedules but can't create.

- Add schedule creation form with cron, flow, repo, summary fields
- Wire to existing RPC method

### Chunk 6: Session Export/Import for TUI and Web

Neither TUI nor Web can export/import sessions.

**Web:** Add Export button to SessionDetail, Import button to SessionsPage
**TUI:** Add export key (E) and import from file

### Chunk 7: Settings Infrastructure

No settings UI on any surface. Superset has: themes, notifications, keyboard, integrations.

**Scope for now (YAGNI):**
- Web: Add Settings page with theme toggle (dark/light) using existing config.yaml
- TUI: Already has theme toggle -- verify it works
- Skip: notifications, keyboard shortcuts, integrations (no backend for these yet)

## Approach

Each chunk is independent. Implement as separate commits. Web changes are React components. TUI changes are Ink components with useInput handlers. Both talk to the same RPC/REST backend -- no backend changes needed (all endpoints exist).

## Testing

Each chunk gets e2e tests added to the existing packages/e2e/ suite.
