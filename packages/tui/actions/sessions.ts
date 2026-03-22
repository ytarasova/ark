import * as core from "../../core/index.js";
import { state } from "../state.js";
import { screen, statusBar } from "../layout.js";
import { renderAll } from "../render/index.js";
import { showNewSessionForm } from "../forms/new-session.js";

export function registerSessionActions() {
  screen.key(["enter"], () => {
    if (state.tab === "sessions") {
      const topLevel = state.sessions.filter((s) => !s.parent_id);
      const s = topLevel[state.sel];
      if (s && (s.status === "ready" || s.status === "blocked")) {
        statusBar.setContent(`{yellow-fg} Dispatching ${s.id}...{/yellow-fg}`);
        screen.render();
        // Run dispatch async, don't block the event loop
        setTimeout(async () => {
          try {
            await core.dispatch(s.id);
          } catch (e: any) {
            statusBar.setContent(`{red-fg} Dispatch failed: ${e.message}{/red-fg}`);
          }
          renderAll();
        }, 0);
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
        statusBar.setContent(`{yellow-fg} Resuming ${s.id}...{/yellow-fg}`);
        screen.render();
        setTimeout(async () => {
          try {
            await core.resume(s.id);
          } catch {}
          renderAll();
        }, 0);
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
