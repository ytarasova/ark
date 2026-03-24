#!/usr/bin/env bun
import React from "react";
import { render } from "ink";
import { appendFileSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { App } from "./App.js";
import { getPostExitAction } from "./post-exit.js";

// ── Global logging ──────────────────────────────────────────────────────────
const LOG_DIR = join(homedir(), ".ark", "logs");
mkdirSync(LOG_DIR, { recursive: true });
const LOG_FILE = join(LOG_DIR, "tui.log");

function log(level: string, msg: string): void {
  const ts = new Date().toISOString();
  try { appendFileSync(LOG_FILE, `${ts} [${level}] ${msg}\n`); } catch {}
}

process.on("unhandledRejection", (err: any) => {
  log("ERROR", `Unhandled rejection: ${err?.message ?? err}`);
});

process.on("uncaughtException", (err: any) => {
  log("CRASH", `${err?.message ?? err}\n${err?.stack ?? ""}`);
  process.stderr.write(`\nTUI crash: ${err?.message ?? err}\nLog: ${LOG_FILE}\n`);
  process.exit(1);
});

log("INFO", "TUI starting");

// ── Start embedded conductor ────────────────────────────────────────────────
import { startConductor } from "../core/conductor.js";
try {
  startConductor(19100, { quiet: true });
  log("INFO", "Conductor started on port 19100");
} catch (e: any) {
  log("WARN", `Conductor start failed (may already be running): ${e.message}`);
}

// ── Terminal check ──────────────────────────────────────────────────────────
if (!process.stdin.isTTY) {
  log("ERROR", "stdin is not a TTY");
  process.stderr.write("Error: ark tui requires a terminal (TTY)\n");
  process.exit(1);
}

try { process.stdin.setRawMode(true); process.stdin.setRawMode(false); } catch {}

// ── Render ───────────────────────────────────────────────────────────────────
try {
  const { waitUntilExit } = render(
    <App />,
    { patchConsole: false, exitOnCtrlC: true },
  );
  log("INFO", "TUI rendered");
  await waitUntilExit();
  log("INFO", "TUI exited");
} catch (e: any) {
  log("CRASH", `Render failed: ${e.message}\n${e.stack}`);
  process.stderr.write(`\nTUI failed: ${e.message}\nLog: ${LOG_FILE}\n`);
  process.exit(1);
}

// Post-exit actions (attach/ssh) are now handled inline in components
// via Bun.Terminal PTY — no need to exit/re-launch the TUI
