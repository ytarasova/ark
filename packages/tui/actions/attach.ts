import { execFileSync } from "child_process";
import { join } from "path";
import { homedir } from "os";
import { state } from "../state.js";
import { screen } from "../layout.js";
import { addHostLog } from "../state.js";
import { renderAll } from "../render/index.js";

// Path to TUI entry point for re-launch after attach
const TUI_ENTRY = join(import.meta.dir, "..", "index.ts");

function relaunchTui(): void {
  try {
    execFileSync(process.execPath, [TUI_ENTRY], { stdio: "inherit" });
  } catch { /* TUI exited */ }
  process.exit(0);
}

export function registerAttachActions() {
  screen.key(["a"], () => {
    if (state.tab === "sessions") {
      const topLevel = state.sessions.filter((s) => !s.parent_id);
      const s = topLevel[state.sel];
      if (!s?.session_id) return;

      // Verify tmux session exists before destroying screen
      try {
        execFileSync("tmux", ["has-session", "-t", s.session_id], { stdio: "pipe" });
      } catch {
        // tmux session doesn't exist
        return;
      }

      screen.destroy();
      try {
        execFileSync("tmux", ["attach", "-t", s.session_id], { stdio: "inherit" });
      } catch { /* user detached */ }
      relaunchTui();

    } else if (state.tab === "hosts") {
      const h = state.hosts[state.sel];
      if (!h || h.status !== "running") return;
      const ip = (h.config as any)?.ip;
      if (!ip) return;

      screen.destroy();
      const keyPath = join(homedir(), ".ssh", `ark-${h.name}`);
      try {
        execFileSync("ssh", ["-i", keyPath, "-o", "StrictHostKeyChecking=no", `ubuntu@${ip}`], { stdio: "inherit" });
      } catch { /* user exited */ }
      relaunchTui();
    }
  });
}
