import { execFileSync } from "child_process";
import { join } from "path";
import { homedir } from "os";
import { state, selectedSession, selectedHost } from "../state.js";
import { screen } from "../layout.js";
import { addHostLog } from "../state.js";
import { renderAll } from "../render/index.js";

// Path to TUI entry point for re-launch after attach
const TUI_ENTRY = join(import.meta.dir, "..", "index.ts");

function relaunchTui(): void {
  try {
    // Reset terminal state before re-launching (clears tmux/ssh artifacts)
    execFileSync("reset", [], { stdio: "inherit" });
  } catch { /* reset not available */ }
  try {
    execFileSync(process.execPath, [TUI_ENTRY], { stdio: "inherit" });
  } catch { /* TUI exited */ }
  process.exit(0);
}

export function registerAttachActions() {
  screen.key(["a"], () => {
    if (state.tab === "sessions") {
      const s = selectedSession();
      if (!s?.session_id) return;

      // Verify tmux session exists before destroying screen
      try {
        execFileSync("tmux", ["has-session", "-t", s.session_id], { stdio: "pipe" });
      } catch {
        const { statusBar } = require("../layout.js");
        statusBar.setContent(`{red-fg} No active tmux session for ${s.id}. Agent may have exited. Try re-dispatching (Enter).{/red-fg}`);
        screen.render();
        return;
      }

      // Write alternate screen escape to hide blessed, then exec into tmux
      process.stdout.write("\x1b[?1049l\x1b[?25h"); // exit alt screen, show cursor
      try {
        execFileSync("tmux", ["attach", "-t", s.session_id], { stdio: "inherit" });
      } catch { /* user detached */ }
      // Reset terminal and re-launch TUI
      process.stdout.write("\x1b[2J\x1b[H"); // clear screen
      relaunchTui();

    } else if (state.tab === "hosts") {
      const h = selectedHost();
      if (!h || h.status !== "running") return;
      const ip = (h.config as any)?.ip;
      if (!ip) return;

      process.stdout.write("\x1b[?1049l\x1b[?25h");
      const keyPath = join(homedir(), ".ssh", `ark-${h.name}`);
      try {
        execFileSync("ssh", ["-i", keyPath, "-o", "StrictHostKeyChecking=no", `ubuntu@${ip}`], { stdio: "inherit" });
      } catch { /* user exited */ }
      relaunchTui();
    }
  });
}
