#!/usr/bin/env bun
import React from "react";
import { render } from "ink";
import { execFileSync } from "child_process";
import { App } from "./App.js";
import { getPostExitAction } from "./post-exit.js";

process.on("unhandledRejection", () => {});

// Ensure terminal is in a clean state (may be corrupted after tmux detach)
if (process.stdin.isTTY && !process.stdin.isRaw) {
  try { process.stdin.setRawMode(true); process.stdin.setRawMode(false); } catch {}
}

const { waitUntilExit } = render(<App />, {
  patchConsole: false,
  exitOnCtrlC: true,
});

// Wait for Ink to fully unmount
await waitUntilExit();

// Check if a component requested a post-exit action
const action = getPostExitAction();
if (action) {
  if (action.type === "tmux-attach") {
    try {
      execFileSync("tmux", ["attach", "-t", ...action.args], { stdio: "inherit" });
    } catch (e: any) {
      // If attach failed, show why
      process.stderr.write(`\nAttach failed: ${e.message ?? e}\n`);
    }
  } else if (action.type === "ssh") {
    try {
      execFileSync("ssh", action.args, { stdio: "inherit" });
    } catch (e: any) {
      process.stderr.write(`\nSSH failed: ${e.message ?? e}\n`);
    }
  }
}
