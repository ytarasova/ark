/**
 * Hotkey configuration — remappable keyboard shortcuts.
 * Config in ~/.ark/config.yaml under `hotkeys:` section.
 */

import { loadConfig } from "./config.js";

export interface HotkeyMap {
  [action: string]: string | null;  // null = disabled
}

// Default hotkey bindings
const DEFAULTS: HotkeyMap = {
  dispatch: "Enter",
  stop: "s",
  restart: "r",
  fork: "f",
  delete: "x",
  attach: "a",
  talk: "t",
  mcp: "M",
  move: "m",
  search: "/",
  newSession: "n",
  complete: "d",
  clone: "C",
  group: "o",
  inbox: "T",
  events: "e",
  filterRunning: "!",
  filterWaiting: "@",
  filterStopped: "#",
  filterFailed: "$",
  filterClear: "0",
  undo: "ctrl+z",
  markUnread: "u",
  skills: "K",
  settings: "P",
  advance: "A",
  worktreeFinish: "W",
  interrupt: "I",
  memory: "Y",
  verify: "V",
  archive: "Z",
  export: "E",
  groupByStatus: "%",
};

let _hotkeys: HotkeyMap | null = null;

/** Get the effective hotkey map (config overrides + defaults). */
export function getHotkeys(): HotkeyMap {
  if (_hotkeys) return _hotkeys;

  try {
    const config = loadConfig();
    const overrides = config.hotkeys ?? {};
    _hotkeys = { ...DEFAULTS, ...overrides };
  } catch {
    _hotkeys = { ...DEFAULTS };
  }

  return _hotkeys;
}

/** Check if a key input matches a hotkey action. */
export function matchesHotkey(action: string, input: string, key: { ctrl?: boolean; meta?: boolean }): boolean {
  const hotkeys = getHotkeys();
  const binding = hotkeys[action];
  if (binding === null || binding === "") return false;  // disabled
  if (!binding) return false;

  // Handle ctrl+ bindings
  if (binding.startsWith("ctrl+")) {
    const char = binding.slice(5);
    return input === char && key.ctrl === true;
  }

  return input === binding;
}

/** Reset cached hotkeys (for testing or after config change). */
export function resetHotkeys(): void {
  _hotkeys = null;
}

/** Get the display label for a hotkey. */
export function hotkeyLabel(action: string): string {
  const hotkeys = getHotkeys();
  return hotkeys[action] ?? "";
}
