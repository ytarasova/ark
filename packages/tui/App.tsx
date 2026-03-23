import React, { useState } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import { useStore } from "./hooks/useStore.js";
import { useAsync } from "./hooks/useAsync.js";
import { TabBar } from "./components/TabBar.js";
import type { Tab } from "./components/TabBar.js";
import { StatusBar } from "./components/StatusBar.js";
import { SessionsTab } from "./tabs/SessionsTab.js";
import { HostsTab } from "./tabs/HostsTab.js";
import { AgentsTab } from "./tabs/AgentsTab.js";
import { PipelinesTab } from "./tabs/PipelinesTab.js";
import { NewSessionForm } from "./forms/NewSessionForm.js";
import { NewHostForm } from "./forms/NewHostForm.js";

export function App() {
  const { exit } = useApp();
  const store = useStore();
  const asyncState = useAsync();
  const [tab, setTab] = useState<Tab>("sessions");
  const [showForm, setShowForm] = useState<string | null>(null);
  const { stdout } = useStdout();
  const termHeight = stdout?.rows ?? 40;

  useInput((input, key) => {
    // Don't handle global keys when a form is showing (let form handle Esc)
    if (showForm) return;

    if (input === "q") {
      exit();
    } else if (input === "1") {
      setTab("sessions");
    } else if (input === "2") {
      setTab("hosts");
    } else if (input === "3") {
      setTab("agents");
    } else if (input === "4") {
      setTab("pipelines");
    } else if (input === "5") {
      setTab("recipes");
    } else if (key.tab) {
      const tabs: Tab[] = ["sessions", "hosts", "agents", "pipelines", "recipes"];
      const idx = tabs.indexOf(tab);
      setTab(tabs[(idx + 1) % tabs.length]!);
    }
  });

  return (
    <Box flexDirection="column" height={termHeight}>
      <TabBar active={tab} />

      {showForm === "session" ? (
        <NewSessionForm
          store={store}
          async={asyncState}
          onDone={() => setShowForm(null)}
        />
      ) : showForm === "host" ? (
        <NewHostForm async={asyncState} onDone={() => setShowForm(null)} />
      ) : tab === "sessions" ? (
        <SessionsTab
          {...store}
          async={asyncState}
          onShowForm={() => setShowForm("session")}
        />
      ) : tab === "hosts" ? (
        <HostsTab
          {...store}
          async={asyncState}
          onShowForm={() => setShowForm("host")}
        />
      ) : tab === "agents" ? (
        <AgentsTab {...store} />
      ) : tab === "pipelines" ? (
        <PipelinesTab {...store} />
      ) : (
        <Box flexGrow={1} justifyContent="center" alignItems="center">
          <Text dimColor>{"Recipes - coming soon"}</Text>
        </Box>
      )}

      <StatusBar
        tab={tab}
        sessions={store.sessions}
        loading={asyncState.loading}
        error={asyncState.error}
        label={asyncState.label}
      />
    </Box>
  );
}
