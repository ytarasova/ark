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
import { addHostLog, state } from "./state.js";
import { statusBar } from "./layout.js";

// ── Global error boundary ───────────────────────────────────────────────────
process.on("unhandledRejection", (err: any) => {
  const msg = err?.message ?? String(err);
  // Log to the current host if on hosts tab
  if (state.tab === "hosts" && state.hosts[state.sel]) {
    addHostLog(state.hosts[state.sel].name, `ERROR: ${msg}`);
  }
  // Always show in status bar
  statusBar.setContent(`{red-fg} Error: ${msg.slice(0, 120)}{/red-fg}`);
  try { renderAll(); } catch { /* don't recurse */ }
});

process.on("uncaughtException", (err: any) => {
  const msg = err?.message ?? String(err);
  if (state.tab === "hosts" && state.hosts[state.sel]) {
    addHostLog(state.hosts[state.sel].name, `CRASH: ${msg}`);
  }
  statusBar.setContent(`{red-fg} Crash: ${msg.slice(0, 120)}{/red-fg}`);
  try { renderAll(); } catch { /* don't recurse */ }
});

// ── Initialize ──────────────────────────────────────────────────────────────
registerNavigation();
registerSessionActions();
registerHostActions();
registerAttachActions();
startPolling();
renderAll();
