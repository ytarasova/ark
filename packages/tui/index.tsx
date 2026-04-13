#!/usr/bin/env bun
import React from "react";
import { render } from "ink";
import { appendFileSync, mkdirSync } from "fs";
import { join } from "path";
import { AppContext, setApp } from "../core/app.js";
import { loadConfig } from "../core/config.js";
import { App } from "./App.js";
import { ArkClientProvider } from "./context/ArkClientProvider.js";

// ── Resolve remote mode ────────────────────────────────────────────────────
const remoteServerUrl = process.env.ARK_TUI_SERVER || process.env.ARK_SERVER;
const remoteToken = process.env.ARK_TUI_TOKEN || process.env.ARK_TOKEN;
const isRemote = !!remoteServerUrl;

// ── Boot application ────────────────────────────────────────────────────────
// In local mode, boot AppContext (conductor + DB + services) as the daemon
// backend. The TUI itself is a pure client -- all data flows through ArkClient
// RPC calls, never direct getApp()/AppContext access from components.
let app: AppContext | null = null;
const config = loadConfig();
if (!isRemote) {
  app = new AppContext(config);
  setApp(app);
  await app.boot();
}

// ── Logging ─────────────────────────────────────────────────────────────────
const logDir = config.logDir ?? join(process.env.HOME ?? "/tmp", ".ark", "logs");
try { mkdirSync(logDir, { recursive: true }); } catch { /* log dir may already exist */ }
const LOG_FILE = join(logDir, "tui.log");

function log(level: string, msg: string): void {
  const ts = new Date().toISOString();
  try { appendFileSync(LOG_FILE, `${ts} [${level}] ${msg}\n`); } catch { /* logging is best-effort */ }
}

process.on("unhandledRejection", (err: any) => {
  log("ERROR", `Unhandled rejection: ${err?.message ?? err}`);
});

process.on("SIGTERM", () => { log("SIGNAL", "SIGTERM received"); });
process.on("SIGHUP", () => { log("SIGNAL", "SIGHUP received"); });
process.on("SIGINT", () => { log("SIGNAL", "SIGINT received"); });
process.on("beforeExit", (code) => { log("EXIT", `beforeExit code=${code}`); });
process.on("exit", (code) => {
  try { require("fs").appendFileSync(LOG_FILE, `${new Date().toISOString()} [EXIT] process.exit code=${code} stack=${new Error().stack}\n`); } catch {}
});

process.on("uncaughtException", (err: any) => {
  log("CRASH", `${err?.message ?? err}\n${err?.stack ?? ""}`);
  process.stderr.write(`\nTUI crash: ${err?.message ?? err}\nLog: ${LOG_FILE}\n`);
  const cleanup = app ? app.shutdown() : Promise.resolve();
  cleanup.then(() => process.exit(1));
});

if (isRemote) {
  log("INFO", `TUI starting in remote mode (server: ${remoteServerUrl})`);
} else {
  log("INFO", `TUI starting (conductor port ${config.conductorPort})`);
}

// ── Terminal check ──────────────────────────────────────────────────────────
if (!process.stdin.isTTY) {
  log("ERROR", "stdin is not a TTY");
  process.stderr.write("Error: ark tui requires a terminal (TTY)\n");
  if (app) await app.shutdown();
  process.exit(1);
}

try { process.stdin.setRawMode(true); process.stdin.setRawMode(false); } catch { /* stdin may not be a TTY */ }

// ── Resolve arkDir for UI state persistence ─────────────────────────────────
const arkDir = config.arkDir ?? join(process.env.HOME ?? "/tmp", ".ark");

// ── Render ──────────────────────────────────────────────────────────────────
try {
  const { waitUntilExit } = render(
    <ArkClientProvider serverUrl={remoteServerUrl} token={remoteToken} app={app ?? undefined}>
      <App arkDir={arkDir} />
    </ArkClientProvider>,
    { patchConsole: false, exitOnCtrlC: true },
  );
  log("INFO", "TUI rendered");
  await waitUntilExit();
  log("INFO", "TUI exited");
  if (app) await app.shutdown();
  process.exit(0);
} catch (e: any) {
  log("CRASH", `Render failed: ${e.message}\n${e.stack}`);
  process.stderr.write(`\nTUI failed: ${e.message}\nLog: ${LOG_FILE}\n`);
  if (app) await app.shutdown();
  process.exit(1);
}
