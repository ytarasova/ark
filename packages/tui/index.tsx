#!/usr/bin/env bun
import React from "react";
import { render } from "ink";
import { appendFileSync, mkdirSync } from "fs";
import { join } from "path";
import { AppContext, setApp } from "../core/app.js";
import { loadConfig } from "../core/config.js";
import { App } from "./App.js";
import { AppProvider } from "./context/AppProvider.js";
import { ArkClientProvider } from "./context/ArkClientProvider.js";

// ── Resolve remote mode ────────────────────────────────────────────────────
const remoteServerUrl = process.env.ARK_TUI_SERVER || process.env.ARK_SERVER;
const remoteToken = process.env.ARK_TUI_TOKEN || process.env.ARK_TOKEN;
const isRemote = !!remoteServerUrl;

// ── Boot application ────────────────────────────────────────────────────────
let app: AppContext | null = null;
if (!isRemote) {
  app = new AppContext(loadConfig());
  setApp(app);
  await app.boot();
}

// ── Logging ─────────────────────────────────────────────────────────────────
const config = app?.config ?? loadConfig();
const logDir = config.logDir ?? join(process.env.HOME ?? "/tmp", ".ark", "logs");
try { mkdirSync(logDir, { recursive: true }); } catch {}
const LOG_FILE = join(logDir, "tui.log");

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

try { process.stdin.setRawMode(true); process.stdin.setRawMode(false); } catch {}

// ── Render ──────────────────────────────────────────────────────────────────
try {
  // In remote mode we use a minimal AppContext (no conductor, no metrics)
  // but AppProvider still needs an AppContext value for components that read config.
  let appForProvider = app;
  if (!appForProvider) {
    appForProvider = new AppContext(loadConfig(), { skipConductor: true, skipMetrics: true });
    await appForProvider.boot();
  }

  const { waitUntilExit } = render(
    <AppProvider app={appForProvider}>
      <ArkClientProvider serverUrl={remoteServerUrl} token={remoteToken}>
        <App />
      </ArkClientProvider>
    </AppProvider>,
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
