import { state, type Tab } from "../state.js";
import { tabBar } from "../layout.js";

export function renderTabBar() {
  const tabs: { key: string; label: string; t: Tab }[] = [
    { key: "1", label: "Sessions", t: "sessions" },
    { key: "2", label: "Agents", t: "agents" },
    { key: "3", label: "Pipelines", t: "pipelines" },
    { key: "4", label: "Recipes", t: "recipes" },
    { key: "5", label: "Hosts", t: "hosts" },
  ];
  const parts = tabs.map((t) =>
    t.t === state.tab
      ? `{black-bg}{white-fg}{bold} ${t.key}:${t.label} {/bold}{/white-fg}{/black-bg}`
      : `{gray-fg} ${t.key}:${t.label} {/gray-fg}`
  );
  tabBar.setContent(parts.join(" "));
}
