#!/usr/bin/env bun
import React from "react";
import { render } from "ink";
import { execFileSync } from "child_process";
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
  log("CRASH", `Uncaught exception: ${err?.message ?? err}\n${err?.stack ?? ""}`);
  process.stderr.write(`\nTUI crash: ${err?.message ?? err}\nLog: ${LOG_FILE}\n`);
  process.exit(1);
});

log("INFO", "TUI starting");

// ── Terminal reset ──────────────────────────────────────────────────────────
if (!process.stdin.isTTY) {
  log("ERROR", "stdin is not a TTY - cannot run TUI");
  process.stderr.write("Error: ark tui requires a terminal (TTY)\n");
  process.exit(1);
}

try {
  process.stdin.setRawMode(true);
  process.stdin.setRawMode(false);
} catch (e: any) {
  log("WARN", `Raw mode reset failed: ${e.message}`);
}

// ── Render ───────────────────────────────────────────────────────────────────
try {
  const { waitUntilExit } = render(<App />, {
    patchConsole: false,
    exitOnCtrlC: true,
  });

  log("INFO", "TUI rendered, waiting for exit");
  await waitUntilExit();
  log("INFO", "TUI exited cleanly");
} catch (e: any) {
  log("CRASH", `Render failed: ${e.message}\n${e.stack}`);
  process.stderr.write(`\nTUI failed to start: ${e.message}\nLog: ${LOG_FILE}\n`);
  process.exit(1);
}

// ── Post-exit action ─────────────────────────────────────────────────────────
const action = getPostExitAction();
if (action) {
  log("INFO", `Post-exit action: ${action.type} ${action.args.join(" ")}`);
  if (action.type === "tmux-attach") {
    try {
      execFileSync("tmux", ["attach", "-t", ...action.args], { stdio: "inherit" });
      log("INFO", "tmux detached");
    } catch (e: any) {
      log("ERROR", `Attach failed: ${e.message}`);
      process.stderr.write(`\nAttach failed: ${e.message ?? e}\n`);
    }
  } else if (action.type === "ssh") {
    try {
      execFileSync("ssh", action.args, { stdio: "inherit" });
      log("INFO", "SSH exited");
    } catch (e: any) {
      log("ERROR", `SSH failed: ${e.message}`);
      process.stderr.write(`\nSSH failed: ${e.message ?? e}\n`);
    }
  }
}
