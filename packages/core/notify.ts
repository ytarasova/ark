/**
 * OS-level notifications - best-effort, never throws.
 *
 * Uses terminal-notifier if available (no permission dialogs),
 * falls back to terminal bell. Avoids osascript which triggers
 * the Script Editor permission dialog on modern macOS.
 */

import { execFile, execFileSync } from "child_process";

let _notifierChecked = false;
let _hasTerminalNotifier = false;

function hasTerminalNotifier(): boolean {
  if (!_notifierChecked) {
    _notifierChecked = true;
    try {
      execFileSync("which", ["terminal-notifier"], { stdio: "pipe" });
      _hasTerminalNotifier = true;
    } catch {
      _hasTerminalNotifier = false;
    }
  }
  return _hasTerminalNotifier;
}

/**
 * Send an OS notification. Prefers terminal-notifier (brew install terminal-notifier),
 * falls back to terminal bell (\x07). Never throws.
 */
export async function sendOSNotification(title: string, body: string): Promise<void> {
  try {
    if (process.platform === "darwin" && hasTerminalNotifier()) {
      execFile("terminal-notifier", [
        "-title", title,
        "-message", body,
        "-group", "ark",
        "-sound", "default",
      ]);
    } else {
      // Terminal bell - works everywhere, triggers tmux/terminal notification
      process.stderr.write("\x07");
    }
  } catch { /* best-effort */ }
}
