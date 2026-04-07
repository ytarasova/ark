/**
 * Persists TUI state (cursor, tab, scroll) across restarts.
 * Saved to ~/.ark/ui-state.json.
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { ARK_DIR } from "./paths.js";

export interface UiState {
  activeTab: number;
  selectedSessionId: string | null;
  scrollOffset: number;
  statusFilter: string | null;
  previewMode: string | null;
}

const DEFAULT_STATE: UiState = {
  activeTab: 0,
  selectedSessionId: null,
  scrollOffset: 0,
  statusFilter: null,
  previewMode: null,
};

function statePath(): string {
  return join(ARK_DIR(), "ui-state.json");
}

/** Load persisted UI state. Returns defaults if file missing or corrupt. */
export function loadUiState(): UiState {
  try {
    const path = statePath();
    if (!existsSync(path)) return { ...DEFAULT_STATE };
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_STATE, ...parsed };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

/** Save UI state to disk. Non-blocking (fire and forget). */
export function saveUiState(state: Partial<UiState>): void {
  try {
    const current = loadUiState();
    const merged = { ...current, ...state };
    writeFileSync(statePath(), JSON.stringify(merged, null, 2));
  } catch (e: any) {
    // Don't crash on write failure
    console.error("ui-state: save failed:", e?.message ?? e);
  }
}
