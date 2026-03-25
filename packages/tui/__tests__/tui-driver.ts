/**
 * TuiDriver — e2e test harness for the Ark TUI.
 *
 * Launches `ark tui` in a detached tmux session, sends keystrokes,
 * captures screen output, and provides structured queries against
 * terminal regions (tab bar, list pane, detail pane, status bar).
 *
 * Usage:
 *   const tui = new TuiDriver();
 *   await tui.start();
 *   tui.press("2");
 *   await tui.waitFor("Compute");
 *   expect(tui.statusBar()).toContain("0 sessions");
 *   tui.stop();
 */

import { execFileSync } from "child_process";
import { join } from "path";
import * as core from "../../core/index.js";
import { AppContext, setApp, clearApp } from "../../core/app.js";
import { loadConfig } from "../../core/config.js";

const ARK_BIN = join(import.meta.dir, "..", "..", "..", "ark");

// ── Key mapping ─────────────────────────────────────────────────────────────

/** Named keys → tmux send-keys syntax */
const KEY_MAP: Record<string, string> = {
  enter: "Enter",
  escape: "Escape",
  tab: "Tab",
  up: "Up",
  down: "Down",
  left: "Left",
  right: "Right",
  backspace: "BSpace",
  delete: "DC",
  home: "Home",
  end: "End",
  pageup: "NPage",
  pagedown: "PPage",
  "ctrl+c": "C-c",
  "ctrl+d": "C-d",
  "ctrl+z": "C-z",
  space: "Space",
};

/** Resolve a key name to tmux syntax. Single chars pass through. */
function resolveKey(key: string): string {
  return KEY_MAP[key.toLowerCase()] ?? key;
}

// ── Screen region parsing ───────────────────────────────────────────────────

export interface ScreenRegions {
  /** Raw full screen text */
  raw: string;
  /** All lines as an array */
  lines: string[];
  /** First line (tab bar) */
  tabBar: string;
  /** Last non-empty line (status bar / key hints) */
  statusBar: string;
  /** Lines between tab bar and status bar (the main content area) */
  body: string[];
  /** Left half of body lines (list pane, approx first 50% of width) */
  listPane: string[];
  /** Right half of body lines (detail pane, approx last 50% of width) */
  detailPane: string[];
}

/**
 * Parse raw tmux screen output into regions.
 *
 * Layout assumption (matches App.tsx):
 *   Line 0:           TabBar
 *   Lines 1..N-2:     SplitPane (left list | right detail)
 *   Line N-1:         StatusBar / key hints
 */
function parseRegions(raw: string, width: number): ScreenRegions {
  const lines = raw.split("\n");

  // Strip trailing empty lines
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") {
    lines.pop();
  }

  const tabBar = lines[0] ?? "";
  const statusBar = lines[lines.length - 1] ?? "";
  const body = lines.slice(1, -1);

  // Split each body line at midpoint for left/right panes.
  // The SplitPane component uses roughly 50/50 or a fixed left width.
  // We use a heuristic: find the column with the most "│" or "|" chars.
  const midCol = findDividerColumn(body, width);

  const listPane = body.map((line) => line.slice(0, midCol).trimEnd());
  const detailPane = body.map((line) => line.slice(midCol).trimStart());

  return { raw, lines, tabBar, statusBar, body, listPane, detailPane };
}

/** Find the column that likely divides the two panes. */
function findDividerColumn(body: string[], width: number): number {
  // Count vertical-bar-like chars per column
  const counts = new Array(width).fill(0);
  for (const line of body) {
    for (let i = 0; i < line.length && i < width; i++) {
      if (line[i] === "│" || line[i] === "|" || line[i] === "┃") {
        counts[i]++;
      }
    }
  }

  // Find column with max count in the middle third of the screen
  const lo = Math.floor(width * 0.2);
  const hi = Math.floor(width * 0.8);
  let bestCol = Math.floor(width / 2);
  let bestCount = 0;
  for (let i = lo; i < hi; i++) {
    if (counts[i] > bestCount) {
      bestCount = counts[i];
      bestCol = i;
    }
  }

  // If no divider found, default to half width
  return bestCount > body.length * 0.3 ? bestCol : Math.floor(width / 2);
}

// ── ANSI stripping ──────────────────────────────────────────────────────────

/** Strip ANSI escape codes from text. */
function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, "");
}

// ── TuiDriver ───────────────────────────────────────────────────────────────

export interface TuiDriverOptions {
  /** Terminal width (default 200) */
  width?: number;
  /** Terminal height (default 50) */
  height?: number;
  /** Max time to wait for TUI to render (default 15000ms) */
  startTimeout?: number;
  /** Text to wait for on startup (default "Sessions") */
  startMarker?: string;
  /** Additional env vars to pass to the TUI process */
  env?: Record<string, string>;
}

/** Allocate a random port in the ephemeral range for test conductor. */
function randomPort(): number {
  return 19200 + Math.floor(Math.random() * 800);
}

export class TuiDriver {
  readonly name: string;
  readonly width: number;
  readonly height: number;
  /** Isolated conductor port for this test instance. */
  readonly conductorPort: number;

  private _started = false;
  private _stopped = false;
  private readonly _opts: Required<TuiDriverOptions>;
  private _app: AppContext | null = null;

  /** Session IDs created via core API — cleaned up on stop() */
  private readonly _sessionIds: string[] = [];

  constructor(opts?: TuiDriverOptions) {
    this.name = `ark-e2e-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    this.width = opts?.width ?? 200;
    this.height = opts?.height ?? 50;
    this.conductorPort = randomPort();
    this._opts = {
      width: this.width,
      height: this.height,
      startTimeout: opts?.startTimeout ?? 15_000,
      startMarker: opts?.startMarker ?? "Sessions",
      env: opts?.env ?? {},
    };

    // Boot the AppContext eagerly — forTest() skips conductor/metrics/signals
    // so boot() completes synchronously (no real awaits in that path).
    this._app = AppContext.forTest();
    this._app.boot(); // intentionally not awaited; sync for test contexts
    setApp(this._app);
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────

  /** Launch the TUI in a detached tmux session. */
  async start(): Promise<void> {
    if (this._started) throw new Error("TuiDriver already started");
    this._started = true;

    const testDir = this._app!.config.arkDir;
    const extraEnv = Object.entries(this._opts.env)
      .map(([k, v]) => `${k}=${v}`)
      .join(" ");

    execFileSync("tmux", [
      "new-session", "-d", "-s", this.name,
      "-x", String(this.width), "-y", String(this.height),
      "bash", "-c",
      `ARK_TEST_DIR='${testDir}' ARK_CONDUCTOR_PORT=${this.conductorPort} ${extraEnv} ${ARK_BIN} tui`,
    ], { stdio: "pipe" });

    const ready = await this.waitFor(this._opts.startMarker, this._opts.startTimeout);
    if (!ready) {
      const content = this.screenRaw();
      this.stop();
      throw new Error(
        `TUI did not render "${this._opts.startMarker}" within ${this._opts.startTimeout}ms.\nScreen:\n${content}`,
      );
    }
  }

  /** Kill the tmux session and clean up tracked resources. */
  stop(): void {
    if (this._stopped) return;
    this._stopped = true;

    // Kill tmux session
    try {
      execFileSync("tmux", ["kill-session", "-t", this.name], { stdio: "pipe" });
    } catch { /* already dead */ }

    // Clean up sessions created via createSession()
    for (const id of this._sessionIds) {
      try {
        const s = core.getSession(id);
        if (s?.session_id) {
          try { core.killSession(s.session_id); } catch { /* gone */ }
        }
        core.deleteSession(id);
      } catch { /* gone */ }
    }
    this._sessionIds.length = 0;

    // Shut down the AppContext and clear the global singleton
    this._app?.shutdown().then(() => {}).catch(() => {});
    clearApp();
    this._app = null;
  }

  /** Check if the tmux session is still alive. */
  alive(): boolean {
    try {
      execFileSync("tmux", ["has-session", "-t", this.name], { stdio: "pipe" });
      return true;
    } catch {
      return false;
    }
  }

  // ── Session helpers (with automatic cleanup) ───────────────────────────

  /** Create a session via core API and track it for cleanup on stop(). */
  createSession(opts: Parameters<typeof core.startSession>[0]): ReturnType<typeof core.startSession> {
    const session = core.startSession(opts);
    this._sessionIds.push(session.id);
    return session;
  }

  /** Remove a session ID from the cleanup tracker (e.g., after manual delete). */
  untrack(sessionId: string): void {
    const idx = this._sessionIds.indexOf(sessionId);
    if (idx >= 0) this._sessionIds.splice(idx, 1);
  }

  // ── Screen capture ────────────────────────────────────────────────────

  /** Capture raw screen content (ANSI codes stripped). */
  screenRaw(): string {
    try {
      const raw = execFileSync("tmux", [
        "capture-pane", "-t", this.name, "-p", "-S", `-${this.height}`,
      ], { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
      return stripAnsi(raw);
    } catch {
      return "";
    }
  }

  /** Capture and parse screen into regions. */
  screen(): ScreenRegions {
    return parseRegions(this.screenRaw(), this.width);
  }

  /** Get full screen text (shorthand for screenRaw). */
  text(): string {
    return this.screenRaw();
  }

  // ── Input ─────────────────────────────────────────────────────────────

  /** Send a single key. Accepts named keys: "enter", "escape", "tab", "ctrl+c", etc. */
  press(key: string): void {
    execFileSync("tmux", ["send-keys", "-t", this.name, resolveKey(key)], { stdio: "pipe" });
  }

  /** Send multiple keys in sequence with a small delay between each. */
  async pressSequence(keys: string[], delayMs = 100): Promise<void> {
    for (const key of keys) {
      this.press(key);
      await sleep(delayMs);
    }
  }

  /** Type text character by character (no trailing Enter). */
  typeChars(text: string): void {
    for (const ch of text) {
      execFileSync("tmux", ["send-keys", "-t", this.name, "-l", ch], { stdio: "pipe" });
    }
  }

  /** Type text followed by Enter. */
  type(text: string): void {
    execFileSync("tmux", ["send-keys", "-t", this.name, "-l", text], { stdio: "pipe" });
    this.press("enter");
  }

  // ── Navigation shortcuts ──────────────────────────────────────────────

  /** Switch to a tab by number (1-6). */
  async switchTab(n: 1 | 2 | 3 | 4 | 5 | 6): Promise<void> {
    const tabNames = ["Sessions", "Agents", "Tools", "Flows", "History", "Compute"];
    this.press(String(n));
    await this.waitFor(tabNames[n - 1]);
  }

  /** Move selection down N times. */
  async selectDown(n = 1): Promise<void> {
    for (let i = 0; i < n; i++) {
      this.press("j");
      await sleep(50);
    }
  }

  /** Move selection up N times. */
  async selectUp(n = 1): Promise<void> {
    for (let i = 0; i < n; i++) {
      this.press("k");
      await sleep(50);
    }
  }

  /** Toggle focus between left and right panes. */
  togglePane(): void {
    this.press("tab");
  }

  // ── Waiting ───────────────────────────────────────────────────────────

  /**
   * Wait until the screen contains text.
   *
   * @param text - String or regex to match against the full screen.
   * @param timeoutMs - Max time to wait (default 5000ms).
   * @param opts.pollMs - Poll interval (default 200ms).
   * @param opts.region - Limit search to a specific region.
   */
  async waitFor(
    text: string | RegExp,
    timeoutMs = 5000,
    opts?: { pollMs?: number; region?: keyof ScreenRegions },
  ): Promise<boolean> {
    const poll = opts?.pollMs ?? 200;
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const content = opts?.region
        ? this.getRegionText(opts.region)
        : this.screenRaw();
      if (matches(content, text)) return true;
      await sleep(poll);
    }
    return false;
  }

  /**
   * Wait until the screen does NOT contain text.
   */
  async waitForGone(
    text: string | RegExp,
    timeoutMs = 5000,
    opts?: { pollMs?: number; region?: keyof ScreenRegions },
  ): Promise<boolean> {
    const poll = opts?.pollMs ?? 200;
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const content = opts?.region
        ? this.getRegionText(opts.region)
        : this.screenRaw();
      if (!matches(content, text)) return true;
      await sleep(poll);
    }
    return false;
  }

  /**
   * Wait for a condition function to return true.
   * Useful for complex assertions that can't be expressed as text matching.
   */
  async waitUntil(
    condition: (screen: ScreenRegions) => boolean,
    timeoutMs = 5000,
    pollMs = 200,
  ): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (condition(this.screen())) return true;
      await sleep(pollMs);
    }
    return false;
  }

  // ── Assertions ────────────────────────────────────────────────────────

  /** Assert that a region contains text. Throws with a helpful message on failure. */
  expectRegion(region: keyof ScreenRegions, text: string | RegExp): void {
    const content = this.getRegionText(region);
    if (!matches(content, text)) {
      throw new Error(
        `Expected ${region} to contain ${text}, but got:\n${content}`,
      );
    }
  }

  /** Assert that a region does NOT contain text. */
  expectRegionNot(region: keyof ScreenRegions, text: string | RegExp): void {
    const content = this.getRegionText(region);
    if (matches(content, text)) {
      throw new Error(
        `Expected ${region} NOT to contain ${text}, but it does:\n${content}`,
      );
    }
  }

  // ── Debugging ─────────────────────────────────────────────────────────

  /** Print the current screen to stderr (useful for debugging failing tests). */
  dump(label?: string): void {
    const screen = this.screenRaw();
    const header = label ? `── ${label} ` : "── screen ";
    console.error(`${header}${"─".repeat(Math.max(0, 60 - header.length))}`);
    console.error(screen);
    console.error("─".repeat(60));
  }

  /** Save a screenshot to a file. */
  screenshot(filePath: string): void {
    const { writeFileSync } = require("fs");
    writeFileSync(filePath, this.screenRaw(), "utf-8");
  }

  // ── Internal ──────────────────────────────────────────────────────────

  private getRegionText(region: keyof ScreenRegions): string {
    const regions = this.screen();
    const value = regions[region];
    if (Array.isArray(value)) return value.join("\n");
    return value;
  }
}

// ── Utilities ───────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function matches(content: string, pattern: string | RegExp): boolean {
  if (typeof pattern === "string") return content.includes(pattern);
  return pattern.test(content);
}
