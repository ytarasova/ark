/**
 * Ark Desktop - Electron main process.
 *
 * Boots the Ark server (AppContext + web dashboard) in a child process,
 * then opens a BrowserWindow pointed at the local server.
 *
 * The web UI is served from packages/web/dist/ (pre-built React SPA).
 * All Ark features (sessions, compute, flows, etc.) work through the
 * REST API + SSE live updates -- same as `ark web` but in a native window.
 */

const { app, BrowserWindow, shell, Menu, dialog } = require("electron");
app.setName("Ark");
const { spawn, execFile } = require("child_process");
const path = require("path");
const net = require("net");
const fs = require("fs");
const http = require("http");

// ── Configuration ──────────────────────────────────────────────────────────

const DEFAULT_PORT = 8420;
const APP_TITLE = "Ark";

// ── State ──────────────────────────────────────────────────────────────────

let mainWindow = null;
let serverProcess = null;
let serverPort = DEFAULT_PORT;

// ── Helpers ────────────────────────────────────────────────────────────────

/** Find the ark CLI binary */
function findArkBin() {
  const candidates = [
    path.join(__dirname, "..", "..", "ark"),
    "/usr/local/bin/ark",
    path.join(process.env.HOME || "", ".bun/bin/ark"),
  ];
  for (const p of candidates) {
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch { /* not found */ }
  }
  return null;
}

/** Find a free port starting from the default */
function findFreePort(startPort) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(startPort, () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
    server.on("error", () => {
      findFreePort(startPort + 1).then(resolve);
    });
  });
}

/** Wait for the server to be ready */
function waitForServer(port, timeout = 15000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    function check() {
      if (Date.now() - start > timeout) {
        reject(new Error("Server startup timeout"));
        return;
      }
      const req = http.get(`http://localhost:${port}/api/status`, (res) => {
        if (res.statusCode === 200) resolve();
        else setTimeout(check, 300);
      });
      req.on("error", () => setTimeout(check, 300));
      req.end();
    }
    check();
  });
}

// ── Server management ──────────────────────────────────────────────────────

async function startServer() {
  const arkBin = findArkBin();
  if (!arkBin) {
    dialog.showErrorBox("Ark Not Found",
      "Could not find the `ark` CLI. Install it with:\n\n" +
      "  cd <ark-repo> && make install\n\n" +
      "Then restart Ark Desktop.");
    app.quit();
    return;
  }

  serverPort = await findFreePort(DEFAULT_PORT);

  // Launch `ark web --port <port>` as a child process
  // The ark script is a bash wrapper, so spawn it directly (not via bun)
  serverProcess = spawn(arkBin, ["web", "--port", String(serverPort)], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PATH: `${process.env.HOME}/.bun/bin:${process.env.PATH}` },
  });

  serverProcess.stdout.on("data", (data) => {
    console.log(`[ark] ${data.toString().trim()}`);
  });

  serverProcess.stderr.on("data", (data) => {
    console.error(`[ark] ${data.toString().trim()}`);
  });

  serverProcess.on("exit", (code) => {
    console.log(`[ark] server exited with code ${code}`);
    serverProcess = null;
  });

  try {
    await waitForServer(serverPort);
  } catch {
    dialog.showErrorBox("Startup Error",
      "The Ark server failed to start within 15 seconds.\n\n" +
      "Check that Bun and Ark are installed correctly.");
    app.quit();
  }
}

function stopServer() {
  if (serverProcess) {
    serverProcess.kill();
    serverProcess = null;
  }
}

// ── Window ─────────────────────────────────────────────────────────────────

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: APP_TITLE,
    titleBarStyle: "hidden",
    trafficLightPosition: { x: 16, y: 16 },
    titleBarOverlay: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      nodeIntegration: false,
      contextIsolation: true,
    },
    backgroundColor: "#1a1b26",
    show: false,
  });

  mainWindow.loadURL(`http://localhost:${serverPort}`);

  // Show when ready (avoids white flash)
  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
    mainWindow.focus();
  });

  // Open external links in system browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http")) shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

// ── Menu ───────────────────────────────────────────────────────────────────

function buildMenu() {
  const isMac = process.platform === "darwin";
  const template = [
    ...(isMac ? [{
      label: APP_TITLE,
      submenu: [
        { role: "about" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    }] : []),
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { role: "resetZoom" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "Window",
      submenu: [
        { role: "minimize" },
        { role: "zoom" },
        ...(isMac ? [{ type: "separator" }, { role: "front" }] : [{ role: "close" }]),
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ── App lifecycle ──────────────────────────────────────────────────────────

app.whenReady().then(async () => {
  buildMenu();
  await startServer();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    stopServer();
    app.quit();
  }
});

app.on("before-quit", () => {
  stopServer();
});
