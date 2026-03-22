#!/usr/bin/env bun
/**
 * Ark TUI — blessed-based dashboard with proper split panes.
 *
 * Layout:
 * ┌─ Tab Bar ──────────────────────────────────────────────────┐
 * │ 1:Sessions  2:Agents  3:Pipelines  4:Recipes               │
 * ├─ List ──────────────┬─ Detail ─────────────────────────────┤
 * │ ▸ ◎ Auth middleware │ T-1  Auth middleware                  │
 * │   ◎ Fix bug         │                                       │
 * │   ◎ Update deps     │ ◎ plan > ○ implement > ○ pr          │
 * │                     │                                       │
 * │                     │ Info                                   │
 * │                     │  ID: s-abc123                          │
 * │                     │  Status: ready                         │
 * │                     │                                       │
 * │                     │ Events                                 │
 * │                     │  14:08 session_created ...             │
 * ├─ Status Bar ────────┴───────────────────────────────────────┤
 * │ 3 sessions  j/k:move Enter:dispatch q:quit                  │
 * └─────────────────────────────────────────────────────────────┘
 */

import { registerNavigation } from "./actions/navigation.js";
import { registerSessionActions } from "./actions/sessions.js";
import { registerHostActions } from "./actions/hosts.js";
import { registerAttachActions } from "./actions/attach.js";
import { startPolling } from "./polling.js";
import { renderAll } from "./render/index.js";

registerNavigation();
registerSessionActions();
registerHostActions();
registerAttachActions();
startPolling();
renderAll();
