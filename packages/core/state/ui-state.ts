/**
 * Persists TUI state (cursor, tab, scroll) across restarts.
 * Saved to ~/.ark/ui-state.json.
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";

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

function statePath(arkDir: string): string {
  return join(arkDir, "ui-state.json");
}

/** Load persisted UI state. Returns defaults if file missing or corrupt. */
export function loadUiState(arkDir?: string): UiState {
  if (!arkDir) return { ...DEFAULT_STATE };
  try {
    const path = statePath(arkDir);
    if (!existsSync(path)) return { ...DEFAULT_STATE };
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_STATE, ...parsed };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

/** Save UI state to disk. Non-blocking (fire and forget). */
export function saveUiState(state: Partial<UiState>, arkDir?: string): void {
  if (!arkDir) return;
  try {
    const current = loadUiState(arkDir);
    const merged = { ...current, ...state };
    writeFileSync(statePath(arkDir), JSON.stringify(merged, null, 2));
  } catch (e: any) {
    // Don't crash on write failure
    console.error("ui-state: save failed:", e?.message ?? e);
  }
}
