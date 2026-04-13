#!/usr/bin/env bun
import React from "react";
import { render } from "ink";
import { appendFileSync, mkdirSync } from "fs";
import { join } from "path";
import { App } from "./App.js";
import { ArkClientProvider } from "./context/ArkClientProvider.js";

// ── Resolve mode ───────────────────────────────────────────────────────────
const remoteServerUrl = process.env.ARK_TUI_SERVER || process.env.ARK_SERVER;
const remoteToken = process.env.ARK_TUI_TOKEN || process.env.ARK_TOKEN;
const embedded = process.env.ARK_TUI_EMBEDDED === "1";

// ── Logging ────────────────────────────────────────────────────────────────
const arkDir = process.env.ARK_DIR ?? join(process.env.HOME ?? "/tmp", ".ark");
const logDir = join(arkDir, "logs");
try { mkdirSync(logDir, { recursive: true }); } catch { /* log dir may already exist */ }
const LOG_FILE = join(logDir, "tui.log");

function log(level: string, msg: string): void {
  const ts = new Date().toISOString();
  try { appendFileSync(LOG_FILE, `${ts} [${level}] ${msg}\n`); } catch { /* logging is best-effort */ }
}

process.on("unhandledRejection", (err: any) => {
  log("ERROR", `Unhandled rejection: ${err?.message ?? err}`);
});

// ── Boot application ───────────────────────────────────────────────────────
let serverUrl: string;
let token: string | undefined = remoteToken;
let app: any = null; // Only set in embedded mode

if (remoteServerUrl) {
  // Remote mode: connect to a remote Ark server
  serverUrl = remoteServerUrl;
  log("INFO", `TUI starting in remote mode (server: ${serverUrl})`);
} else if (embedded) {
  // Embedded mode: boot AppContext in-process (legacy fallback)
  const { AppContext, setApp } = await import("../core/app.js");
  const { loadConfig } = await import("../core/config.js");
  const config = loadConfig();
  app = new AppContext(config);
  setApp(app);
  await app.boot();
  serverUrl = ""; // ArkClientProvider handles in-process mode when app is provided
  log("INFO", `TUI starting in embedded mode (conductor port ${config.conductorPort})`);
} else {
  // Daemon mode (default): connect to local server daemon via WebSocket
  const port = parseInt(process.env.ARK_SERVER_PORT ?? "19400", 10);
  serverUrl = `http://localhost:${port}`;
  await ensureDaemon(port);
  log("INFO", `TUI starting in daemon mode (port ${port})`);
}

async function ensureDaemon(port: number): Promise<void> {
  // Probe health
  try {
    const resp = await fetch(`http://localhost:${port}/health`, { signal: AbortSignal.timeout(2000) });
    if (resp.ok) return; // Already running
  } catch { /* not running */ }

  // Auto-start the daemon
  log("INFO", `Daemon not running on port ${port}, auto-starting...`);
  const arkBin = process.argv[1];
  const proc = Bun.spawn({
    cmd: ["bun", arkBin, "server", "daemon", "start", "--detach", "--port", String(port)],
    stdio: ["ignore", "ignore", "ignore"],
    env: { ...process.env },
  });
  proc.unref();

  // Poll health until ready (up to 10s)
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    await Bun.sleep(500);
    try {
      const resp = await fetch(`http://localhost:${port}/health`, { signal: AbortSignal.timeout(2000) });
      if (resp.ok) {
        log("INFO", `Daemon started successfully on port ${port}`);
        return;
      }
    } catch { /* keep waiting */ }
  }

  process.stderr.write(`Error: Could not start server daemon on port ${port}\n`);
  process.stderr.write(`Try starting it manually: ark server daemon start\n`);
  process.exit(1);
}

process.on("uncaughtException", (err: any) => {
  log("CRASH", `${err?.message ?? err}\n${err?.stack ?? ""}`);
  process.stderr.write(`\nTUI crash: ${err?.message ?? err}\nLog: ${LOG_FILE}\n`);
  const cleanup = app ? app.shutdown() : Promise.resolve();
  cleanup.then(() => process.exit(1));
});

// ── Terminal check ─────────────────────────────────────────────────────────
if (!process.stdin.isTTY) {
  log("ERROR", "stdin is not a TTY");
  process.stderr.write("Error: ark tui requires a terminal (TTY)\n");
  if (app) await app.shutdown();
  process.exit(1);
}

try { process.stdin.setRawMode(true); process.stdin.setRawMode(false); } catch { /* stdin may not be a TTY */ }

// ── Render ─────────────────────────────────────────────────────────────────
try {
  const { waitUntilExit } = render(
    <ArkClientProvider
      serverUrl={serverUrl || undefined}
      token={token}
      app={embedded ? app : undefined}
    >
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
