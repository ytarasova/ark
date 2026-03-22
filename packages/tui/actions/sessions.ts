import * as core from "../../core/index.js";
import { state, selectedSession } from "../state.js";
import { screen } from "../layout.js";
import { renderAll } from "../render/index.js";
import { runAsync } from "../async.js";
import { showNewSessionForm } from "../forms/new-session.js";

export function registerSessionActions() {
  screen.key(["enter"], () => {
    if (state.tab === "sessions") {
      const s = selectedSession();
      if (s && (s.status === "ready" || s.status === "blocked")) {
        runAsync(`Dispatching ${s.id}`, () => core.dispatch(s.id).then(() => {}));
      }
    }
  });

  screen.key(["c"], () => {
    if (state.tab === "sessions") {
      const s = selectedSession();
      if (s && s.status === "running") {
        core.complete(s.id);
        renderAll();
      }
    }
  });

  screen.key(["s"], () => {
    if (state.tab === "sessions") {
      const s = selectedSession();
      if (s && !["completed", "failed"].includes(s.status)) {
        core.stop(s.id);
        renderAll();
      }
    }
  });

  screen.key(["r"], () => {
    if (state.tab === "sessions") {
      const s = selectedSession();
      if (s && ["blocked", "waiting", "failed"].includes(s.status)) {
        runAsync(`Resuming ${s.id}`, () => core.resume(s.id).then(() => {}));
      }
    }
  });

  screen.key(["x"], () => {
    if (state.tab === "sessions") {
      const s = selectedSession();
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
