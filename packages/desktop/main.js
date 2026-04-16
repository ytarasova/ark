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

/** Find the ark CLI binary.
 * Priority:
 *   1. Bundled ark-native inside the packaged app (process.resourcesPath)
 *   2. Development: repo-root ark wrapper (../../ark)
 *   3. /usr/local/bin/ark (installed via CLI install dialog or manually)
 *   4. ~/.bun/bin/ark (bun global install)
 */
function findArkBin() {
  // In a packaged app, prefer the bundled ark-native binary
  if (app.isPackaged) {
    const bundled = path.join(process.resourcesPath, "ark-native");
    try {
      fs.accessSync(bundled, fs.constants.X_OK);
      return bundled;
    } catch {
      // Bundled binary missing or not executable -- fall through to PATH lookup
    }
  }

  const candidates = [
    path.join(__dirname, "..", "..", "ark"),
    "/usr/local/bin/ark",
    path.join(process.env.HOME || "", ".bun/bin/ark"),
  ];
  for (const p of candidates) {
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch {
      /* not found */
    }
  }
  return null;
}

/** Get the path to the bundled ark-native binary (packaged app only). */
function getBundledArkPath() {
  if (!app.isPackaged) return null;
  const bundled = path.join(process.resourcesPath, "ark-native");
  try {
    fs.accessSync(bundled, fs.constants.X_OK);
    return bundled;
  } catch {
    return null;
  }
}

/** Check if the CLI install flag file exists. */
function isCliInstalled() {
  const flagPath = path.join(process.env.HOME || "", ".ark", "cli-installed");
  try {
    fs.accessSync(flagPath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/** Mark CLI as installed by writing the flag file. */
function markCliInstalled() {
  const arkDir = path.join(process.env.HOME || "", ".ark");
  try {
    fs.mkdirSync(arkDir, { recursive: true });
    fs.writeFileSync(path.join(arkDir, "cli-installed"), new Date().toISOString());
  } catch {
    // Non-critical -- dialog will just show again next launch
  }
}

/** Install CLI tools by symlinking the bundled binary to /usr/local/bin/ark.
 * On macOS, uses osascript for admin privilege escalation if needed.
 * On Linux AppImage, uses pkexec if available.
 * Returns true on success.
 */
async function installCliTools() {
  const bundledPath = getBundledArkPath();
  if (!bundledPath) return false;

  const targetPath = "/usr/local/bin/ark";
  const isMac = process.platform === "darwin";
  const isLinux = process.platform === "linux";

  // Try direct symlink first (works if user has write access to /usr/local/bin)
  try {
    try { fs.unlinkSync(targetPath); } catch { /* may not exist */ }
    fs.symlinkSync(bundledPath, targetPath);
    markCliInstalled();
    return true;
  } catch {
    // Permission denied -- escalate
  }

  if (isMac) {
    // Use osascript to prompt for admin password (inputs are hardcoded paths,
    // not user-supplied -- no injection risk)
    try {
      execFile("/usr/bin/osascript", [
        "-e",
        `do shell script "ln -sf '${bundledPath}' '${targetPath}'" with administrator privileges`,
      ], { timeout: 30000 }, (err) => { if (err) throw err; });
      // Wait briefly for the async execFile to complete
      await new Promise((resolve) => setTimeout(resolve, 2000));
      markCliInstalled();
      return true;
    } catch {
      return false;
    }
  }

  if (isLinux) {
    // Try pkexec for graphical sudo
    try {
      execFile("pkexec", ["ln", "-sf", bundledPath, targetPath], { timeout: 30000 }, () => {});
      await new Promise((resolve) => setTimeout(resolve, 2000));
      markCliInstalled();
      return true;
    } catch {
      return false;
    }
  }

  return false;
}

/** Show the first-launch CLI install dialog (if not already installed). */
async function maybeOfferCliInstall() {
  if (!app.isPackaged) return;
  if (isCliInstalled()) return;

  const bundledPath = getBundledArkPath();
  if (!bundledPath) return;

  // Check if /usr/local/bin/ark already exists and works
  try {
    fs.accessSync("/usr/local/bin/ark", fs.constants.X_OK);
    markCliInstalled();
    return;
  } catch {
    // Not installed -- offer to install
  }

  const result = await dialog.showMessageBox(mainWindow || null, {
    type: "question",
    buttons: ["Install", "Skip"],
    defaultId: 0,
    cancelId: 1,
    title: "Install CLI Tools",
    message: "Install Ark CLI tools?",
    detail:
      "Ark can install its CLI tools so you can use `ark` from the terminal.\n\n" +
      "This creates a symlink at /usr/local/bin/ark pointing to the bundled binary.\n" +
      "You may be prompted for your administrator password.",
  });

  if (result.response === 0) {
    const success = await installCliTools();
    if (success) {
      dialog.showMessageBox(mainWindow || null, {
        type: "info",
        title: "CLI Installed",
        message: "Ark CLI tools installed successfully.",
        detail: "You can now use `ark` from any terminal window.",
      });
    } else {
      dialog.showMessageBox(mainWindow || null, {
        type: "warning",
        title: "Installation Failed",
        message: "Could not install CLI tools.",
        detail:
          "You can install manually by running:\n\n" +
          `  sudo ln -sf "${bundledPath}" /usr/local/bin/ark`,
      });
    }
  }
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
      const req = http.get(`http://localhost:${port}/api/health`, (res) => {
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
    dialog.showErrorBox(
      "Ark Not Found",
      "Could not find the `ark` CLI. Install it with:\n\n" +
        "  cd <ark-repo> && make install\n\n" +
        "Then restart Ark Desktop.",
    );
    app.quit();
    return;
  }

  serverPort = await findFreePort(DEFAULT_PORT);

  // Launch `ark web --with-daemon --port <port>` as a child process.
  // --with-daemon starts the conductor (:19100) and arkd (:19300) in-process,
  // so the user gets a fully functional Ark instance without manually running
  // `ark daemon start`. If those ports are already in use (the user has an
  // external daemon), `ark web` reuses them instead.
  // The ark script is a bash wrapper, so spawn it directly (not via bun).
  serverProcess = spawn(arkBin, ["web", "--with-daemon", "--port", String(serverPort)], {
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
    dialog.showErrorBox(
      "Startup Error",
      "The Ark server failed to start within 15 seconds.\n\n" + "Check that Bun and Ark are installed correctly.",
    );
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
  const isMac = process.platform === "darwin";
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: APP_TITLE,
    // On macOS, "hiddenInset" gives the traffic lights their own native inset
    // region above the sidebar header so they don't overlap the "ark" brand.
    // On Windows/Linux, "hidden" hides the chrome (no traffic-light equivalent).
    titleBarStyle: isMac ? "hiddenInset" : "hidden",
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
    ...(isMac
      ? [
          {
            label: APP_TITLE,
            submenu: [
              { role: "about" },
              { type: "separator" },
              {
                label: "Install CLI Tools...",
                click: async () => {
                  const bundledPath = getBundledArkPath();
                  if (!bundledPath) {
                    dialog.showMessageBox(mainWindow || null, {
                      type: "info",
                      title: "CLI Tools",
                      message: "CLI tools are only available in the packaged app.",
                      detail: "In development mode, use `make install` from the repo root.",
                    });
                    return;
                  }
                  const success = await installCliTools();
                  if (success) {
                    dialog.showMessageBox(mainWindow || null, {
                      type: "info",
                      title: "CLI Installed",
                      message: "Ark CLI tools installed successfully.",
                      detail: "You can now use `ark` from any terminal window.",
                    });
                  } else {
                    dialog.showMessageBox(mainWindow || null, {
                      type: "warning",
                      title: "Installation Failed",
                      message: "Could not install CLI tools.",
                      detail:
                        "You can install manually by running:\n\n" +
                        `  sudo ln -sf "${bundledPath}" /usr/local/bin/ark`,
                    });
                  }
                },
              },
              { type: "separator" },
              { role: "hide" },
              { role: "hideOthers" },
              { role: "unhide" },
              { type: "separator" },
              { role: "quit" },
            ],
          },
        ]
      : []),
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
    ...(!isMac
      ? [
          {
            label: "Tools",
            submenu: [
              {
                label: "Install CLI Tools...",
                click: async () => {
                  const bundledPath = getBundledArkPath();
                  if (!bundledPath) {
                    dialog.showMessageBox(mainWindow || null, {
                      type: "info",
                      title: "CLI Tools",
                      message: "CLI tools are only available in the packaged app.",
                      detail: "In development mode, use `make install` from the repo root.",
                    });
                    return;
                  }
                  const success = await installCliTools();
                  if (success) {
                    dialog.showMessageBox(mainWindow || null, {
                      type: "info",
                      title: "CLI Installed",
                      message: "Ark CLI tools installed successfully.",
                      detail: "You can now use `ark` from any terminal window.",
                    });
                  } else {
                    dialog.showMessageBox(mainWindow || null, {
                      type: "warning",
                      title: "Installation Failed",
                      message: "Could not install CLI tools.",
                      detail:
                        "You can install manually by running:\n\n" +
                        `  sudo ln -sf "${bundledPath}" /usr/local/bin/ark`,
                    });
                  }
                },
              },
            ],
          },
        ]
      : []),
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ── App lifecycle ──────────────────────────────────────────────────────────

// Single-instance lock: prevents a second launch from spawning another
// `ark web` subprocess on a different port. If we fail to acquire the lock,
// the existing instance focuses its window and this process exits.
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    buildMenu();
    await startServer();
    createWindow();

    // Offer CLI install on first launch (packaged app only)
    await maybeOfferCliInstall();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      }
    });
  });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    stopServer();
    app.quit();
  }
});

app.on("before-quit", () => {
  stopServer();
});
