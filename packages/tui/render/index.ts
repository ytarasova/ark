import { screen } from "../layout.js";
import { refresh } from "../state.js";
import { renderTabBar } from "./tab-bar.js";
import { renderList } from "./list.js";
import { renderDetail } from "./detail.js";
import { renderStatusBar } from "./status-bar.js";

export function renderAll() {
  refresh();
  renderTabBar();
  renderList();
  renderDetail();
  renderStatusBar();
  screen.render();
}
