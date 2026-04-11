/**
 * Tmux status bar integration.
 * Shows waiting sessions with jump shortcuts in tmux status-left.
 *
 * Uses execSync intentionally — tmux CLI requires shell invocation
 * and all arguments are internally constructed (no user input).
 */

import type { AppContext } from "../app.js";
import { execFileSync } from "child_process";
import { tmuxBin } from "./tmux.js";

/** Update tmux status bar with waiting session indicators. */
export function updateTmuxStatusBar(app: AppContext): void {
  try {
    const sessions = app.sessions.list({ limit: 100 });
    const waiting = sessions.filter(s => ["waiting", "blocked"].includes(s.status));

    if (waiting.length === 0) {
      // Clear the status
      execFileSync(tmuxBin(), ["set-option", "-g", "status-left", ""], { stdio: "ignore" });
      return;
    }

    const entries = waiting.slice(0, 6).map((s, i) => {
      const name = (s.summary ?? s.id).slice(0, 15);
      return `#[fg=yellow][${i + 1}]#[fg=white] ${name}`;
    });

    const bar = `#[fg=yellow,bold]⚡ ${entries.join(" ")} `;
    execFileSync(tmuxBin(), ["set-option", "-g", "status-left", bar], { stdio: "ignore" });
  } catch {
    // tmux not available or not in tmux — silently ignore
  }
}

/** Clear the tmux status bar. */
export function clearTmuxStatusBar(): void {
  try {
    execFileSync(tmuxBin(), ["set-option", "-g", "status-left", ""], { stdio: "ignore" });
  } catch { /* ignore */ }
}
