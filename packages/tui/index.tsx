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

// ── Terminal check ──────────────────────────────────────────────────────────
if (!process.stdin.isTTY) {
  log("ERROR", "stdin is not a TTY");
  process.stderr.write("Error: ark tui requires a terminal (TTY)\n");
  process.exit(1);
}

try { process.stdin.setRawMode(true); process.stdin.setRawMode(false); } catch {}

// ── Render ───────────────────────────────────────────────────────────────────
try {
  const { waitUntilExit } = render(<App />, { patchConsole: false, exitOnCtrlC: true });
  log("INFO", "TUI rendered");
  await waitUntilExit();
  log("INFO", "TUI exited");
} catch (e: any) {
  log("CRASH", `Render failed: ${e.message}\n${e.stack}`);
  process.stderr.write(`\nTUI failed: ${e.message}\nLog: ${LOG_FILE}\n`);
  process.exit(1);
}

// ── Post-exit action ─────────────────────────────────────────────────────────
const action = getPostExitAction();
if (action) {
  log("INFO", `Post-exit: ${action.type} ${action.args.join(" ")}`);

  const cmd = action.type === "tmux-attach"
    ? ["tmux", "attach", "-t", ...action.args]
    : action.type === "ssh"
    ? ["ssh", ...action.args]
    : null;

  if (cmd) {
    log("INFO", `Running: ${cmd.join(" ")}`);

    // Use Bun.Terminal for proper PTY — gives subprocess a real terminal
    process.stdin.setRawMode(true);
    const proc = Bun.spawn(cmd, {
      terminal: {
        cols: process.stdout.columns ?? 80,
        rows: process.stdout.rows ?? 24,
        data(_terminal, data) {
          process.stdout.write(data);
        },
      },
    });

    // Forward stdin to PTY
    process.stdin.on("data", (chunk: Buffer) => {
      proc.terminal.write(chunk.toString());
    });

    // Handle resize
    process.stdout.on("resize", () => {
      proc.terminal.resize(process.stdout.columns, process.stdout.rows);
    });

    await proc.exited;
    process.stdin.setRawMode(false);
    log("INFO", `${action.type} exited: ${proc.exitCode}`);
  }
}
