// ── Screen & widget creation ─────────────────────────────────────────────────

// Suppress neo-blessed's Setulc terminfo parsing crash on iTerm2/xterm-256color.
// The crash is in blessed's tput.js when it compiles the Setulc capability.
// We patch it by removing Setulc from the terminfo before blessed reads it.
const origTerminfo = process.env.TERMINFO;
const origTerm = process.env.TERM;

import blessed from "neo-blessed";

// Monkey-patch: if blessed throws on Setulc, catch it at the screen level
const _origEmit = process.emit.bind(process);
process.emit = function(event: string, ...args: any[]) {
  if (event === "uncaughtException") {
    const err = args[0];
    if (err?.message?.includes("Setulc") || String(err).includes("Setulc")) {
      // Swallow the Setulc error - it's non-fatal
      return true;
    }
  }
  return _origEmit(event, ...args);
} as any;

export const screen = blessed.screen({
  smartCSR: true,
  title: "Ark - Autonomous Agent Ecosystem",
  fullUnicode: true,
  terminal: "xterm-256color",
  warnings: false,
  forceUnicode: true,
});

export const tabBar = blessed.box({
  parent: screen,
  top: 0,
  left: 0,
  width: "100%",
  height: 1,
  tags: true,
  style: { bg: "black", fg: "white" },
});

export const listPane = blessed.box({
  parent: screen,
  top: 1,
  left: 0,
  width: "40%",
  height: "100%-3",
  border: { type: "line" },
  style: { border: { fg: "gray" } },
  scrollable: true,
  alwaysScroll: true,
  scrollbar: { style: { bg: "gray" } },
  tags: true,
});

export const detailPane = blessed.box({
  parent: screen,
  top: 1,
  left: "40%",
  width: "60%",
  height: "100%-3",
  border: { type: "line" },
  style: { border: { fg: "gray" } },
  scrollable: true,
  alwaysScroll: true,
  scrollbar: { style: { bg: "gray" } },
  keys: true,
  mouse: true,
  tags: true,
});

export const statusBar = blessed.box({
  parent: screen,
  bottom: 0,
  left: 0,
  width: "100%",
  height: 2,
  tags: true,
  style: { bg: "black", fg: "gray" },
});
