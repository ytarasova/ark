import { spawn } from "child_process";
import { join } from "path";
import * as core from "../../core/index.js";
import { state } from "../state.js";
import { screen } from "../layout.js";
import { renderAll } from "../render/index.js";
import { showNewSessionForm } from "../forms/new-session.js";

// Dispatch in a detached child process so the TUI never blocks
function dispatchInBackground(sessionId: string) {
  const arkBin = join(import.meta.dir, "..", "..", "..", "ark");
  spawn("bash", [arkBin, "session", "dispatch", sessionId], {
    detached: true,
    stdio: "ignore",
  }).unref();
}

export function registerSessionActions() {
  screen.key(["enter"], () => {
    if (state.tab === "sessions") {
      const topLevel = state.sessions.filter((s) => !s.parent_id);
      const s = topLevel[state.sel];
      if (s && (s.status === "ready" || s.status === "blocked")) {
        dispatchInBackground(s.id);
        // Show immediate feedback in status bar
        const { statusBar } = require("../layout.js");
        statusBar.setContent(`{yellow-fg} Dispatching ${s.id}...{/yellow-fg}`);
        screen.render();
      }
    }
  });

  screen.key(["c"], () => {
    if (state.tab === "sessions") {
      const topLevel = state.sessions.filter((s) => !s.parent_id);
      const s = topLevel[state.sel];
      if (s && s.status === "running") {
        core.complete(s.id);
        renderAll();
      }
    }
  });

  screen.key(["s"], () => {
    if (state.tab === "sessions") {
      const topLevel = state.sessions.filter((s) => !s.parent_id);
      const s = topLevel[state.sel];
      if (s && !["completed", "failed"].includes(s.status)) {
        core.stop(s.id);
        renderAll();
      }
    }
  });

  screen.key(["r"], () => {
    if (state.tab === "sessions") {
      const topLevel = state.sessions.filter((s) => !s.parent_id);
      const s = topLevel[state.sel];
      if (s && ["blocked", "waiting", "failed"].includes(s.status)) {
        const arkBin = join(import.meta.dir, "..", "..", "..", "ark");
        spawn("bash", [arkBin, "session", "resume", s.id], {
          detached: true, stdio: "ignore",
        }).unref();
        renderAll();
      }
    }
  });

  screen.key(["x"], () => {
    if (state.tab === "sessions") {
      const topLevel = state.sessions.filter((s) => !s.parent_id);
      const s = topLevel[state.sel];
      if (s) {
        if (s.session_id) core.killSession(s.session_id);
        core.deleteSession(s.id);
        if (state.sel > 0) state.sel--;
        renderAll();
      }
    }
  });

  screen.key(["n"], () => {
    if (state.tab === "sessions") {
      showNewSessionForm();
    }
  });
}
