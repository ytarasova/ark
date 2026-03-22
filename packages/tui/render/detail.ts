import { state } from "../state.js";
import { detailPane } from "../layout.js";
import { renderSessionDetail } from "./sessions-detail.js";
import { renderAgentDetail } from "./agents-detail.js";
import { renderPipelineDetail } from "./pipelines-detail.js";
import { renderHostDetail } from "./hosts-detail.js";

export function renderDetail() {
  try { return _renderDetail(); } catch { /* SQLite locked */ }
}

function _renderDetail() {
  let lines: string[] | null = null;

  if (state.tab === "sessions") {
    lines = renderSessionDetail();
    if (!lines) {
      detailPane.setContent("{gray-fg}← select a session{/gray-fg}");
      return;
    }
  } else if (state.tab === "agents") {
    lines = renderAgentDetail();
    if (!lines) { detailPane.setContent(""); return; }
  } else if (state.tab === "pipelines") {
    lines = renderPipelineDetail();
    if (!lines) { detailPane.setContent(""); return; }
  } else if (state.tab === "hosts") {
    lines = renderHostDetail();
    if (!lines) { detailPane.setContent("{gray-fg}← select a host{/gray-fg}"); return; }
  }

  if (lines) {
    detailPane.setContent(lines.join("\n"));
  }
}
