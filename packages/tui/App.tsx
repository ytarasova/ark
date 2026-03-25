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
import { ComputeTab } from "./tabs/ComputeTab.js";
import { AgentsTab } from "./tabs/AgentsTab.js";
import { FlowsTab } from "./tabs/FlowsTab.js";
import { HistoryTab } from "./tabs/HistoryTab.js";
import { NewSessionForm } from "./forms/NewSessionForm.js";
import { NewComputeForm } from "./forms/NewComputeForm.js";

export function App() {
  const { exit } = useApp();
  const store = useStore();
  const asyncState = useAsync(store.refresh);
  const [tab, setTab] = useState<Tab>("sessions");
  const [showForm, setShowForm] = useState<string | null>(null);
  const [eventLogExpanded, setEventLogExpanded] = useState(false);
  const [selectedSession, setSelectedSession] = useState<any>(null);
  const [pane, setPane] = useState<Pane>("left");
  const [childInputActive, setChildInputActive] = useState(false);
  const [activeOverlay, setActiveOverlay] = useState<string | null>(null);
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
    // When a text input is active, only allow Ctrl-based shortcuts
    if (showForm || childInputActive) return;

    if (input === "q") { exit(); return; }
    if (input === "p") { takeSnapshot(); return; }

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
      switchTab("agents");
    } else if (input === "3") {
      switchTab("tools");
    } else if (input === "4") {
      switchTab("flows");
    } else if (input === "5") {
      switchTab("history");
    } else if (input === "6") {
      switchTab("compute");
    }
  });

  return (
    <Box flexDirection="column" height={termHeight}>
      <TabBar active={tab} loading={asyncState.loading} loadingLabel={asyncState.label} />

      {tab === "sessions" ? (
        <SessionsTab
          {...store}
          pane={pane}
          async={asyncState}
          onShowForm={() => setShowForm("session")}
          onSelectionChange={setSelectedSession}
          onInputActive={setChildInputActive}
          onOverlayChange={setActiveOverlay}
          formOverlay={showForm === "session" ? (
            <NewSessionForm
              store={store}
              async={asyncState}
              onDone={() => setShowForm(null)}
            />
          ) : undefined}
        />
      ) : tab === "agents" ? (
        <AgentsTab {...store} pane={pane} />
      ) : tab === "tools" ? (
        <Box flexGrow={1} justifyContent="center" alignItems="center">
          <Text dimColor>{"Tools — coming soon (recipes, skills, prompt templates)"}</Text>
        </Box>
      ) : tab === "flows" ? (
        <FlowsTab {...store} pane={pane} />
      ) : tab === "history" ? (
        <HistoryTab {...store} pane={pane} async={asyncState} onOverlayChange={setActiveOverlay} />
      ) : tab === "compute" ? (
        <ComputeTab
          {...store}
          pane={pane}
          async={asyncState}
          onShowForm={() => setShowForm("compute")}
          formOverlay={showForm === "compute" ? (
            <NewComputeForm async={asyncState} onDone={() => setShowForm(null)} />
          ) : undefined}
        />
      ) : null}

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
        overlay={showForm ? "form" : activeOverlay}
      />
    </Box>
  );
}
