#!/usr/bin/env bun
import React from "react";
import { render } from "ink";
import { appendFileSync, mkdirSync } from "fs";
import { join } from "path";
import { AppContext, setApp } from "../core/app.js";
import { loadConfig } from "../core/config.js";
import { isDaemonRunning } from "../daemon/lockfile.js";
import { checkDaemonHealth } from "../daemon/health.js";
import { App } from "./App.js";
import { ArkClientProvider } from "./context/ArkClientProvider.js";

// -- Resolve remote mode -------------------------------------------------
const remoteServerUrl = process.env.ARK_TUI_SERVER || process.env.ARK_SERVER;
const remoteToken = process.env.ARK_TUI_TOKEN || process.env.ARK_TOKEN;
const isRemote = !!remoteServerUrl;

// -- Resolve daemon mode -------------------------------------------------
// Priority: ARK_TUI_SERVER (remote) > ARK_DAEMON_URL (explicit) > lockfile auto-discovery > in-process
let daemonUrl: string | undefined = process.env.ARK_DAEMON_URL;
const config = loadConfig();

if (!isRemote && !daemonUrl) {
  const arkDir = config.arkDir ?? join(process.env.HOME ?? "/tmp", ".ark");
  const { running, info } = isDaemonRunning(arkDir);
  if (running && info) {
    const healthy = await checkDaemonHealth(info.ws_url);
    if (healthy) {
      daemonUrl = info.ws_url;
    }
  }
}

const useDaemon = !isRemote && !!daemonUrl;

// -- Boot application ----------------------------------------------------
// If a daemon is running, connect via WebSocket (thin client).
// Otherwise, boot AppContext in-process (backward compatible).
let app: AppContext | null = null;
if (!isRemote && !useDaemon) {
  app = new AppContext(config);
  setApp(app);
  await app.boot();
}

// -- Logging -------------------------------------------------------------
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

process.on("uncaughtException", (err: any) => {
  log("CRASH", `${err?.message ?? err}\n${err?.stack ?? ""}`);
  process.stderr.write(`\nTUI crash: ${err?.message ?? err}\nLog: ${LOG_FILE}\n`);
  const cleanup = app ? app.shutdown() : Promise.resolve();
  cleanup.then(() => process.exit(1));
});

if (isRemote) {
  log("INFO", `TUI starting in remote mode (server: ${remoteServerUrl})`);
} else if (useDaemon) {
  log("INFO", `TUI starting in daemon mode (ws: ${daemonUrl})`);
} else {
  log("INFO", `TUI starting (conductor port ${config.conductorPort})`);
}

// -- Terminal check -------------------------------------------------------
if (!process.stdin.isTTY) {
  log("ERROR", "stdin is not a TTY");
  process.stderr.write("Error: ark tui requires a terminal (TTY)\n");
  if (app) await app.shutdown();
  process.exit(1);
}

try { process.stdin.setRawMode(true); process.stdin.setRawMode(false); } catch { /* stdin may not be a TTY */ }

// -- Resolve arkDir for UI state persistence ------------------------------
const arkDir = config.arkDir ?? join(process.env.HOME ?? "/tmp", ".ark");

// -- Resolve serverUrl for ArkClientProvider ------------------------------
// In daemon mode, we pass the WS URL directly as serverUrl so the provider
// connects via WebSocket (same code path as remote mode).
const effectiveServerUrl = isRemote ? remoteServerUrl : useDaemon ? daemonUrl : undefined;
const effectiveToken = isRemote ? remoteToken : undefined;

// -- Render ---------------------------------------------------------------
try {
  const { waitUntilExit } = render(
    <ArkClientProvider serverUrl={effectiveServerUrl} token={effectiveToken} app={app ?? undefined}>
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
