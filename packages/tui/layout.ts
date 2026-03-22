// ── Screen & widget creation ─────────────────────────────────────────────────

import blessed from "neo-blessed";

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
