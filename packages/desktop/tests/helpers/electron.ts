/**
 * Shared Electron launcher for Ark Desktop smoke tests.
 *
 * Each test gets an isolated temp dir (ARK_TEST_DIR) so the embedded
 * `ark web` subprocess runs against a fresh SQLite DB and does not
 * mutate the developer's real ~/.ark state.
 *
 * Port isolation: the embedded web server auto-picks a free port
 * starting at 8420 (see packages/desktop/main.js findFreePort). If a
 * dev daemon holds :19100/:19300, we cannot reuse them, but the
 * desktop app falls back to http-only probes and still boots the UI.
 * Tests that rely on daemon state must tolerate "offline" status.
 */

import { _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Absolute path to the desktop package root (one level up from tests/). */
export const DESKTOP_ROOT = resolve(__dirname, "..", "..");

export interface LaunchedArk {
  app: ElectronApplication;
  window: Page;
  tempDir: string;
}

/**
 * Launch Ark Desktop with an isolated temp dir.
 *
 * Returns the ElectronApplication, the first BrowserWindow (Page), and
 * the temp dir path so teardown can wipe it.
 */
export async function launchArk(): Promise<LaunchedArk> {
  const tempDir = await mkdtemp(join(tmpdir(), "ark-desktop-e2e-"));

  const app = await electron.launch({
    // `electron .` from the desktop package dir. We pass the package dir
    // as cwd + as the positional arg so Electron loads `main.js`.
    // `--user-data-dir` isolates the single-instance lock (main.js calls
    // app.requestSingleInstanceLock(); without a per-test user-data-dir
    // the 2nd, 3rd, ... tests fail to acquire the lock and silently quit).
    args: [`--user-data-dir=${tempDir}/electron-user-data`, DESKTOP_ROOT],
    cwd: DESKTOP_ROOT,
    env: {
      ...process.env,
      // Isolate SQLite DB + any file state under ~/.ark.
      ARK_TEST_DIR: tempDir,
      // Ensure the bundled `ark` CLI (repo root) can run under Bun.
      PATH: `${process.env.HOME}/.bun/bin:${process.env.PATH ?? ""}`,
      // Disable Electron's sandbox for CI (Linux without SUID helper).
      ELECTRON_DISABLE_SANDBOX: "1",
    },
    // Longer boot window: on cold CI runners the `ark web` subprocess
    // takes 10-15s to compile + serve.
    timeout: 30_000,
  });

  // Pipe Electron's own stdout + the ark web child's stdout so test
  // failures surface the boot log (startup errors, port collisions,
  // single-instance-lock bounces). Only active when DEBUG_ELECTRON=1
  // to keep happy-path runs quiet.
  if (process.env.DEBUG_ELECTRON === "1") {
    app.process().stdout?.on("data", (d) => process.stderr.write(`[electron-out] ${d}`));
    app.process().stderr?.on("data", (d) => process.stderr.write(`[electron-err] ${d}`));
  }

  // Wait for the first BrowserWindow. main.js calls `mainWindow.show()` on
  // the `ready-to-show` event, which fires after the React SPA has mounted.
  const window = await app.firstWindow({ timeout: 20_000 });
  await window.waitForLoadState("domcontentloaded");

  return { app, window, tempDir };
}

/** Gracefully shut down Ark and clean up its temp dir. */
export async function closeArk(launched: LaunchedArk | undefined): Promise<void> {
  if (!launched) return;
  const { app, tempDir } = launched;

  // Collect descendant PIDs BEFORE app.close() so we can reap them after.
  // Once app.close() returns, Electron is dead and the bash `ark` wrapper
  // + its bun grandchild have been reparented to init, so `pkill -P
  // <electronPid>` no longer finds them. Capturing them up-front dodges
  // the reparenting race.
  //
  // main.js's `stopServer` only sends SIGTERM to the direct bash child.
  // That shuts down bash but the bun grandchild survives briefly, keeping
  // port 8420+ occupied. Without explicit reaping ports pile up until
  // reboot (we hit 10+ leaked bun processes in dev testing).
  const electronPid = app.process().pid;
  let descendantPids: number[] = [];
  if (electronPid && process.platform !== "win32") {
    try {
      descendantPids = await collectDescendants(electronPid);
    } catch {
      /* best effort */
    }
  }

  // Bounded close: on Linux under xvfb, `app.close()` occasionally
  // hangs waiting for Electron's `before-quit` handler to finish (the
  // embedded `ark web` child delays its SIGTERM ack). We do not have
  // 30s of test-timeout budget to burn in the afterEach hook, so race
  // the graceful close against a 5s deadline and fall through to the
  // hard-kill path regardless.
  await Promise.race([
    app.close().catch(() => {
      /* already gone */
    }),
    new Promise<void>((resolve) => setTimeout(resolve, 5000)),
  ]);

  // Kill all captured descendants. Each might have gone away already
  // (clean SIGTERM chain); `kill -9 <pid>` silently no-ops on dead PIDs.
  if (descendantPids.length > 0 && process.platform !== "win32") {
    try {
      await execFileAsync("/bin/sh", ["-c", `kill -9 ${descendantPids.join(" ")} 2>/dev/null || true`], {
        timeout: 3000,
      });
    } catch {
      /* best effort */
    }
  }

  // Force-kill the Electron main process itself if it survived the
  // 5s close window. Without this, a stuck Electron can keep the
  // worker teardown alive past the 30s ceiling.
  if (electronPid && process.platform !== "win32") {
    try {
      process.kill(electronPid, "SIGKILL");
    } catch {
      /* already dead */
    }
  }

  try {
    await rm(tempDir, { recursive: true, force: true });
  } catch {
    // Temp cleanup is best-effort.
  }
}

/** Walk the process tree rooted at `pid` and return all descendant PIDs. */
async function collectDescendants(pid: number): Promise<number[]> {
  const out: number[] = [];
  const queue: number[] = [pid];
  while (queue.length > 0) {
    const parent = queue.shift()!;
    try {
      const { stdout } = await execFileAsync("/usr/bin/pgrep", ["-P", String(parent)], { timeout: 2000 });
      const kids = stdout
        .split("\n")
        .map((s) => parseInt(s.trim(), 10))
        .filter((n) => !isNaN(n));
      for (const k of kids) {
        out.push(k);
        queue.push(k);
      }
    } catch {
      // pgrep returns non-zero when no matches -- swallow.
    }
  }
  return out;
}

/**
 * Read whether the Electron main process is still running.
 *
 * If `ark web` failed to start, main.js shows a "Startup Error" dialog
 * and calls `app.quit()`. After quit, `app.evaluate` throws, so a
 * surviving evaluate call is the strongest signal the app is alive.
 *
 * We also assert that the app has at least one window -- the startup
 * error path quits before calling `createWindow()`.
 */
export async function appIsStillRunning(app: ElectronApplication): Promise<boolean> {
  try {
    const windowCount = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
    return windowCount > 0;
  } catch {
    return false;
  }
}
