import React, { useState, useCallback } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import { execFileSync } from "child_process";
import { useStore } from "./hooks/useStore.js";
import { useAsync } from "./hooks/useAsync.js";
import { TabBar } from "./components/TabBar.js";
import type { Tab } from "./components/TabBar.js";
import type { Pane } from "./components/SplitPane.js";
import { StatusBar } from "./components/StatusBar.js";
import { EventLog } from "./components/EventLog.js";
import { SessionsTab } from "./tabs/SessionsTab.js";
import { HostsTab } from "./tabs/HostsTab.js";
import { AgentsTab } from "./tabs/AgentsTab.js";
import { FlowsTab } from "./tabs/FlowsTab.js";
import { NewSessionForm } from "./forms/NewSessionForm.js";
import { NewHostForm } from "./forms/NewHostForm.js";

export function App() {
  const { exit } = useApp();
  const store = useStore();
  const asyncState = useAsync();
  const [tab, setTab] = useState<Tab>("sessions");
  const [showForm, setShowForm] = useState<string | null>(null);
  const [eventLogExpanded, setEventLogExpanded] = useState(false);
  const [selectedSession, setSelectedSession] = useState<any>(null);
  const [pane, setPane] = useState<Pane>("left");
  const { stdout } = useStdout();
  const termHeight = stdout?.rows ?? 40;

  const switchTab = (t: Tab) => { setTab(t); setPane("left"); };

  const takeSnapshot = useCallback(() => {
    try {
      if (process.env.TMUX) {
        execFileSync("tmux", ["capture-pane", "-S", "-"], { stdio: "pipe" });
        execFileSync("tmux", ["save-buffer", "-"], { stdio: ["pipe", "pipe", "pipe"] });
        // Pipe buffer to clipboard
        const content = execFileSync("tmux", ["save-buffer", "-"], {
          encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"],
        });
        execFileSync("pbcopy", { input: content, stdio: ["pipe", "pipe", "pipe"] });
      } else {
        // No tmux — not much we can capture
      }
    } catch {}
  }, []);

  useInput((input, key) => {
    // Always available
    if (input === "q") { exit(); return; }
    if (input === "p") { takeSnapshot(); return; }

    if (showForm) return;

    // Tab switches pane focus (all tabs with SplitPane)
    if (key.tab) {
      setPane(p => p === "left" ? "right" : "left");
      return;
    }
    // Esc returns to list pane
    if (key.escape && pane === "right") {
      setPane("left");
      return;
    }

    if (input === "e") {
      setEventLogExpanded((v) => !v);
    } else if (input === "1") {
      switchTab("sessions");
    } else if (input === "2") {
      switchTab("hosts");
    } else if (input === "3") {
      switchTab("agents");
    } else if (input === "4") {
      switchTab("flows");
    } else if (input === "5") {
      switchTab("recipes");
    }
  });

  return (
    <Box flexDirection="column" height={termHeight}>
      <TabBar active={tab} />

      {tab === "sessions" ? (
        <SessionsTab
          {...store}
          pane={pane}
          async={asyncState}
          onShowForm={() => setShowForm("session")}
          onSelectionChange={setSelectedSession}
          formOverlay={showForm === "session" ? (
            <NewSessionForm
              store={store}
              async={asyncState}
              onDone={() => setShowForm(null)}
            />
          ) : undefined}
        />
      ) : tab === "hosts" ? (
        <HostsTab
          {...store}
          pane={pane}
          async={asyncState}
          onShowForm={() => setShowForm("host")}
          formOverlay={showForm === "host" ? (
            <NewHostForm async={asyncState} onDone={() => setShowForm(null)} />
          ) : undefined}
        />
      ) : tab === "agents" ? (
        <AgentsTab {...store} pane={pane} />
      ) : tab === "flows" ? (
        <FlowsTab {...store} pane={pane} />
      ) : (
        <Box flexGrow={1} justifyContent="center" alignItems="center">
          <Text dimColor>{"Recipes - coming soon"}</Text>
        </Box>
      )}

      <EventLog
        expanded={eventLogExpanded}
        onToggle={() => setEventLogExpanded((v) => !v)}
      />

      <StatusBar
        tab={tab}
        sessions={store.sessions}
        selectedSession={selectedSession}
        loading={asyncState.loading}
        error={asyncState.error}
        label={asyncState.label}
        pane={pane}
      />
    </Box>
  );
}
