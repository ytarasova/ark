import { state } from "../state.js";
import { screen } from "../layout.js";

export function registerAttachActions() {
  screen.key(["a"], () => {
    if (state.tab === "sessions") {
      const topLevel = state.sessions.filter((s) => !s.parent_id);
      const s = topLevel[state.sel];
      if (!s?.session_id) return;

      screen.destroy();
      const cp = require("child_process");
      try {
        cp.execFileSync("tmux", ["attach", "-t", s.session_id], { stdio: "inherit" });
      } catch { /* user detached with Ctrl+B D */ }

      cp.execFileSync(process.execPath, [__filename], { stdio: "inherit" });
      process.exit(0);
    } else if (state.tab === "hosts") {
      const h = state.hosts[state.sel];
      if (!h || h.status !== "running") return;
      const ip = (h.config as any)?.ip;
      if (!ip) return;

      screen.destroy();
      const cp = require("child_process");
      const keyPath = require("path").join(require("os").homedir(), ".ssh", `ark-${h.name}`);
      try {
        cp.execFileSync("ssh", ["-i", keyPath, "-o", "StrictHostKeyChecking=no", `ubuntu@${ip}`], { stdio: "inherit" });
      } catch { /* user exited */ }

      cp.execFileSync(process.execPath, [__filename], { stdio: "inherit" });
      process.exit(0);
    }
  });
}
