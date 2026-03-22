/**
 * Async action runner for TUI - yields to blessed event loop,
 * shows progress in status bar, reports errors visibly.
 */

import { statusBar, screen } from "./layout.js";
import { renderAll } from "./render/index.js";

/**
 * Run an async action without blocking the TUI event loop.
 * Shows a progress message, runs the action, shows errors in status bar.
 */
export function runAsync(label: string, action: () => Promise<void>): void {
  statusBar.setContent(`{yellow-fg} ${label}{/yellow-fg}`);
  screen.render();

  setTimeout(async () => {
    try {
      await action();
    } catch (e: any) {
      showError(label, e);
    }
    renderAll();
  }, 0);
}

/**
 * Run a sync action with error reporting to status bar.
 */
export function runSafe<T>(label: string, action: () => T): T | null {
  try {
    return action();
  } catch (e: any) {
    showError(label, e);
    return null;
  }
}

/**
 * Show an error in the status bar.
 */
export function showError(label: string, e: any): void {
  const msg = e?.message ?? String(e);
  statusBar.setContent(`{red-fg} ${label} failed: ${msg.slice(0, 120)}{/red-fg}`);
  screen.render();
}
