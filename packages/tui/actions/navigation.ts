import { state, type Tab } from "../state.js";
import { screen, detailPane } from "../layout.js";
import { renderAll } from "../render/index.js";

function getMax(): number {
  return state.tab === "sessions" ? state.sessions.filter((s) => !s.parent_id).length
    : state.tab === "agents" ? state.agents.length
    : state.tab === "pipelines" ? state.pipelines.length
    : state.tab === "hosts" ? state.hosts.length : 0;
}

export function registerNavigation() {
  screen.key(["q", "C-c"], () => process.exit(0));

  screen.key(["j", "down"], () => {
    const max = getMax();
    if (state.sel < max - 1) state.sel++;
    renderAll();
  });

  screen.key(["k", "up"], () => {
    if (state.sel > 0) state.sel--;
    renderAll();
  });

  screen.key(["1"], () => { state.tab = "sessions"; state.sel = 0; renderAll(); });
  screen.key(["2"], () => { state.tab = "agents"; state.sel = 0; renderAll(); });
  screen.key(["3"], () => { state.tab = "pipelines"; state.sel = 0; renderAll(); });
  screen.key(["4"], () => { state.tab = "recipes"; state.sel = 0; renderAll(); });
  screen.key(["5"], () => { state.tab = "hosts"; state.sel = 0; renderAll(); });

  screen.key(["]", "tab"], () => {
    const tabs: Tab[] = ["sessions", "agents", "pipelines", "recipes", "hosts"];
    state.tab = tabs[(tabs.indexOf(state.tab) + 1) % tabs.length]!;
    state.sel = 0;
    renderAll();
  });

  screen.key(["[", "S-tab"], () => {
    const tabs: Tab[] = ["sessions", "agents", "pipelines", "recipes", "hosts"];
    state.tab = tabs[(tabs.indexOf(state.tab) - 1 + tabs.length) % tabs.length]!;
    state.sel = 0;
    renderAll();
  });

  screen.key(["G"], () => {
    const max = getMax();
    state.sel = Math.max(0, max - 1);
    renderAll();
  });

  screen.key(["g"], () => {
    state.sel = 0;
    renderAll();
  });

  // Detail pane scrolling
  screen.key(["pagedown", "C-d"], () => {
    detailPane.scroll(10);
    screen.render();
  });

  screen.key(["pageup", "C-u"], () => {
    detailPane.scroll(-10);
    screen.render();
  });

  // Shift+j/k for fine scroll
  screen.key(["S-j"], () => {
    detailPane.scroll(3);
    screen.render();
  });

  screen.key(["S-k"], () => {
    detailPane.scroll(-3);
    screen.render();
  });
}
