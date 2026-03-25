#!/usr/bin/env bun
import React from "react";
import { render } from "ink";
import { appendFileSync } from "fs";
import { join } from "path";
import { AppContext, setApp } from "../core/app.js";
import { loadConfig } from "../core/config.js";
import { App } from "./App.js";
import { AppProvider } from "./context/AppProvider.js";

// ── Boot application ────────────────────────────────────────────────────────
const app = new AppContext(loadConfig());
await app.boot();
setApp(app);

// ── Logging ─────────────────────────────────────────────────────────────────
const LOG_FILE = join(app.config.logDir, "tui.log");

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
  app.shutdown().then(() => process.exit(1));
});

log("INFO", `TUI starting (conductor port ${app.config.conductorPort})`);

// ── Terminal check ──────────────────────────────────────────────────────────
if (!process.stdin.isTTY) {
  log("ERROR", "stdin is not a TTY");
  process.stderr.write("Error: ark tui requires a terminal (TTY)\n");
  await app.shutdown();
  process.exit(1);
}

try { process.stdin.setRawMode(true); process.stdin.setRawMode(false); } catch {}

// ── Render ──────────────────────────────────────────────────────────────────
try {
  const { waitUntilExit } = render(
    <AppProvider app={app}>
      <App />
    </AppProvider>,
    { patchConsole: false, exitOnCtrlC: true },
  );
  log("INFO", "TUI rendered");
  await waitUntilExit();
  log("INFO", "TUI exited");
  await app.shutdown();
  process.exit(0);
} catch (e: any) {
  log("CRASH", `Render failed: ${e.message}\n${e.stack}`);
  process.stderr.write(`\nTUI failed: ${e.message}\nLog: ${LOG_FILE}\n`);
  await app.shutdown();
  process.exit(1);
}
