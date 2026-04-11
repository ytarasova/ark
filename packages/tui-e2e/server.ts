/**
 * Ark TUI browser harness server.
 *
 * Spawns `ark tui` inside a real pty (node-pty), pipes stdin/stdout
 * through a WebSocket, and serves a small xterm.js page that renders
 * the pty output in the browser. Playwright drives the page.
 *
 * Isolation:
 *   - Each server instance uses its own `ARK_DIR` (usually a mktemp dir)
 *     so sessions / DB / tracks never leak across tests.
 *   - Each server instance uses its own `TMUX_TMPDIR` so the real tmux
 *     running inside the pty gets a private socket and never touches
 *     the host's user tmux server.
 *   - The bundled `tmux` binary (`dist/ark-<plat>/bin/tmux` or the
 *     matching path in a dev checkout) is prepended to PATH so we use
 *     the same tmux the binary ships with, not whatever the user has
 *     installed.
 *
 * Usage from a test:
 *   import { startHarness } from "../server.js";
 *   const harness = await startHarness({ arkBin: "../ark" });
 *   // Navigate Playwright to harness.pageUrl
 *   // Drive via page.keyboard.type(...)
 *   await harness.stop();
 */

import { spawn, type IPty } from "@homebridge/node-pty-prebuilt-multiarch";
import { WebSocketServer, type WebSocket } from "ws";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Harness options ─────────────────────────────────────────────────────────

export interface HarnessOpts {
  /** Path to the ark binary. Defaults to the repo's root `ark` wrapper. */
  arkBin?: string;
  /** Subcommand + args to pass to ark. Defaults to `["tui"]`. */
  args?: string[];
  /** HTTP port. 0 means ephemeral -- the OS picks a free one. */
  port?: number;
  /** Terminal columns. Default 120. */
  cols?: number;
  /** Terminal rows. Default 32. */
  rows?: number;
  /** Extra env vars to merge on top of the isolated baseline. */
  env?: Record<string, string>;
  /**
   * Pre-allocated ARK_TEST_DIR. When provided, the harness reuses it
   * instead of creating a fresh temp dir -- useful for tests that need
   * to seed state via `runArkCli` BEFORE the TUI opens the DB (otherwise
   * SQLite rejects the second connection with "database is locked").
   * Pattern:
   *
   *   const arkDir = mkTempArkDir();
   *   seedSession(arkDir, { summary: "demo" });
   *   const harness = await startHarness({ arkDir });
   *
   * The harness does NOT delete a caller-provided arkDir on stop().
   */
  arkDir?: string;
}

/** Allocate a fresh temp ARK_TEST_DIR. Caller is responsible for cleanup. */
export function mkTempArkDir(): string {
  return mkdtempSync(join(tmpdir(), `ark-tui-e2e-${randomUUID().slice(0, 8)}-`));
}

export interface Harness {
  /** HTTP URL where the xterm.js page is served. Use with page.goto(). */
  pageUrl: string;
  /** Temp ARK_DIR allocated for this harness. Destroyed on stop(). */
  arkDir: string;
  /** Temp TMUX_TMPDIR allocated for this harness. */
  tmuxTmpDir: string;
  /** The underlying pty process (advanced tests only). */
  pty: IPty;
  /** Kill the pty, shut the server, remove temp dirs. Idempotent. */
  stop: () => Promise<void>;
  /** Write a string to the pty -- same as keystrokes from the user. */
  write: (data: string) => void;
  /** Resize the pty. */
  resize: (cols: number, rows: number) => void;
  /** Accumulated pty output since start (for non-browser assertions). */
  readOutput: () => string;
}

// ── Binary + environment resolution ─────────────────────────────────────────

/** Resolve the ark binary path, falling back to common dev locations. */
function resolveArkBin(hint?: string): string {
  if (hint && existsSync(hint)) return resolve(hint);
  // Common dev locations: repo root ./ark wrapper, built binary, installed
  const candidates = [
    resolve(__dirname, "..", "..", "ark"),
    resolve(__dirname, "..", "..", "ark-native"),
    "/usr/local/bin/ark",
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  throw new Error(
    `Could not locate the ark binary. Checked: ${candidates.join(", ")}. ` +
      `Pass { arkBin } explicitly.`,
  );
}

/** Prepend the bundled tmux dir to PATH if one exists. */
function buildPath(): string {
  const existing = process.env.PATH ?? "";
  const bundled = resolve(__dirname, "..", "..", "dist", `ark-${process.platform}-${process.arch === "x64" ? "x64" : "arm64"}`, "bin");
  if (existsSync(join(bundled, "tmux"))) {
    return `${bundled}:${existing}`;
  }
  return existing;
}

// ── Page HTML ───────────────────────────────────────────────────────────────

/**
 * Static HTML that loads xterm.js from node_modules and mounts it into
 * a full-window terminal, wired to a WebSocket at /pty.
 */
function pageHtml(_port: number, cols: number, rows: number): string {
  // xterm.js and @xterm/addon-fit ship as UMD, not ESM. Load them as
  // classic <script> tags and read the Terminal / FitAddon globals.
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Ark TUI harness</title>
<link rel="stylesheet" href="/xterm.css">
<style>
  html, body { margin: 0; padding: 0; height: 100%; background: #0b0b0c; color: #e4e4e7; font-family: ui-monospace, monospace; }
  #term { position: fixed; inset: 0; padding: 8px; }
  #status { position: fixed; top: 4px; right: 8px; font-size: 11px; opacity: 0.6; z-index: 10; }
</style>
</head>
<body>
<div id="term"></div>
<div id="status">connecting…</div>
<script src="/xterm.js"></script>
<script src="/fit.js"></script>
<script>
  (function () {
    // xterm.js exposes Terminal as a constructor directly, but
    // @xterm/addon-fit exposes a namespace: window.FitAddon.FitAddon.
    var TerminalCtor = window.Terminal;
    var FitAddonNs = window.FitAddon;
    var FitAddonCtor = FitAddonNs && (FitAddonNs.FitAddon || FitAddonNs);
    if (!TerminalCtor || typeof FitAddonCtor !== "function") {
      document.getElementById("status").textContent = "xterm load failed";
      return;
    }

    var term = new TerminalCtor({
      cols: ${cols},
      rows: ${rows},
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      fontSize: 13,
      theme: { background: "#0b0b0c", foreground: "#e4e4e7" },
      cursorBlink: true,
      scrollback: 2000,
      allowProposedApi: true,
    });
    var fit = new FitAddonCtor();
    term.loadAddon(fit);
    term.open(document.getElementById("term"));
    try { fit.fit(); } catch (e) { /* fit may fail before layout */ }

    var status = document.getElementById("status");
    var ws = new WebSocket("ws://" + location.host + "/pty");
    ws.binaryType = "arraybuffer";

    ws.addEventListener("open", function () { status.textContent = "connected"; });
    ws.addEventListener("close", function () { status.textContent = "closed"; });
    ws.addEventListener("error", function () { status.textContent = "error"; });
    ws.addEventListener("message", function (ev) {
      var data = typeof ev.data === "string" ? ev.data : new TextDecoder().decode(ev.data);
      term.write(data);
    });

    term.onData(function (data) {
      if (ws.readyState === WebSocket.OPEN) ws.send(data);
    });

    // Expose terminal handle for Playwright evaluate() assertions
    window.__arkTerm = term;
    window.__arkBuffer = function () {
      var buf = term.buffer.active;
      var lines = [];
      for (var i = 0; i < buf.length; i++) {
        var line = buf.getLine(i);
        if (line) lines.push(line.translateToString(true));
      }
      return lines.join("\\n");
    };
  })();
</script>
</body>
</html>`;
}

// ── Harness lifecycle ───────────────────────────────────────────────────────

export async function startHarness(opts: HarnessOpts = {}): Promise<Harness> {
  const arkBin = resolveArkBin(opts.arkBin);
  const args = opts.args ?? ["tui"];
  const cols = opts.cols ?? 120;
  const rows = opts.rows ?? 32;

  const harnessId = randomUUID().slice(0, 8);
  // Accept a caller-allocated arkDir for seed-before-boot workflows;
  // otherwise allocate one and track ownership so stop() cleans up.
  const arkDir = opts.arkDir ?? mkdtempSync(join(tmpdir(), `ark-tui-e2e-${harnessId}-`));
  const arkDirOwnedByHarness = opts.arkDir === undefined;
  const tmuxTmpDir = mkdtempSync(join(tmpdir(), `ark-tui-e2e-tmux-${harnessId}-`));

  // Ark reads ARK_TEST_DIR (not ARK_DIR) to redirect its state root.
  // See packages/core/config.ts:104 -- process.env.ARK_TEST_DIR is the
  // recognized knob. Using the wrong name silently falls back to
  // ~/.ark, which means the harness would pollute the user's real DB.
  const env: Record<string, string> = {
    ...process.env,
    ARK_TEST_DIR: arkDir,
    TMUX_TMPDIR: tmuxTmpDir,
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    PATH: buildPath(),
    ...(opts.env ?? {}),
  };

  const pty = spawn(arkBin, args, {
    name: "xterm-256color",
    cols,
    rows,
    cwd: arkDir,
    env,
  });

  let buffer = "";
  pty.onData((data) => {
    buffer += data;
  });

  // HTTP server serves the xterm page + node_modules xterm assets
  const xtermNodeModules = resolve(__dirname, "node_modules", "@xterm", "xterm");
  const fitNodeModules = resolve(__dirname, "node_modules", "@xterm", "addon-fit");

  const httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? "/";
    try {
      if (url === "/") {
        const actualPort = (httpServer.address() as { port?: number } | null)?.port ?? 0;
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(pageHtml(actualPort, cols, rows));
        return;
      }
      if (url === "/xterm.css") {
        res.writeHead(200, { "Content-Type": "text/css" });
        res.end(readFileSync(join(xtermNodeModules, "css", "xterm.css")));
        return;
      }
      if (url === "/xterm.js") {
        res.writeHead(200, { "Content-Type": "text/javascript" });
        res.end(readFileSync(join(xtermNodeModules, "lib", "xterm.js")));
        return;
      }
      if (url === "/fit.js") {
        res.writeHead(200, { "Content-Type": "text/javascript" });
        res.end(readFileSync(join(fitNodeModules, "lib", "addon-fit.js")));
        return;
      }
      res.writeHead(404);
      res.end("not found");
    } catch (e: any) {
      res.writeHead(500);
      res.end(`server error: ${e?.message ?? e}`);
    }
  });

  const activeSockets = new Set<WebSocket>();
  const wss = new WebSocketServer({ server: httpServer, path: "/pty" });
  wss.on("connection", (ws: WebSocket) => {
    activeSockets.add(ws);
    // Replay buffer on connect so the page shows the TUI from the beginning
    if (buffer) ws.send(buffer);
    const dataListener = (data: string) => {
      if (ws.readyState === ws.OPEN) ws.send(data);
    };
    const onData = pty.onData(dataListener);
    ws.on("message", (msg) => {
      const data = typeof msg === "string" ? msg : msg.toString("utf-8");
      pty.write(data);
    });
    ws.on("close", () => {
      activeSockets.delete(ws);
      onData.dispose();
    });
  });

  const port: number = await new Promise((resolveP, rejectP) => {
    httpServer.listen(opts.port ?? 0, "127.0.0.1", () => {
      const addr = httpServer.address();
      if (!addr || typeof addr === "string") {
        rejectP(new Error("failed to bind http server"));
        return;
      }
      resolveP(addr.port);
    });
    httpServer.on("error", rejectP);
  });

  const pageUrl = `http://127.0.0.1:${port}/`;

  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    // Kill the pty hard so tmux + agents + children all go away.
    try { pty.kill("SIGKILL"); } catch { /* already dead */ }
    // Forcibly terminate every live WebSocket so the http server's
    // connection count drops to zero and httpServer.close() can resolve.
    for (const ws of activeSockets) {
      try { ws.terminate(); } catch { /* ignore */ }
    }
    activeSockets.clear();
    try { wss.close(); } catch { /* ignore */ }
    // Fall back to closeAllConnections (Node 18.2+) if anything is still
    // keeping the server alive, then race close() against a 2s timeout
    // so the test doesn't hang on a stuck socket.
    try {
      (httpServer as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
    } catch { /* ignore */ }
    await Promise.race([
      new Promise<void>((res) => httpServer.close(() => res())),
      new Promise<void>((res) => setTimeout(res, 2000)),
    ]);
    if (arkDirOwnedByHarness) {
      try { rmSync(arkDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    try { rmSync(tmuxTmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  };

  return {
    pageUrl,
    arkDir,
    tmuxTmpDir,
    pty,
    stop,
    write: (data: string) => pty.write(data),
    resize: (c: number, r: number) => pty.resize(c, r),
    readOutput: () => buffer,
  };
}

// ── Standalone dev entrypoint ───────────────────────────────────────────────

// When invoked directly (`bun run server.ts`), start a harness on a
// well-known port so a developer can open http://127.0.0.1:9876/ and
// watch the TUI render live in the browser.
if (import.meta.main) {
  const harness = await startHarness({ port: 9876 });
  console.log(`Ark TUI harness: ${harness.pageUrl}`);
  console.log(`ARK_DIR: ${harness.arkDir}`);
  console.log(`TMUX_TMPDIR: ${harness.tmuxTmpDir}`);
  const shutdown = async () => {
    console.log("\nstopping harness…");
    await harness.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
