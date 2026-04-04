import React, { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import { execFile } from "child_process";
import { useStore } from "./hooks/useStore.js";
import { useAsync } from "./hooks/useAsync.js";
import { FocusProvider, useFocus } from "./hooks/useFocus.js";
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
import { ToolsTab } from "./tabs/ToolsTab.js";
import { CostsTab } from "./tabs/CostsTab.js";
import * as core from "../core/index.js";
import { NewSessionForm, type SessionPrefill } from "./forms/NewSessionForm.js";
import { NewComputeForm } from "./forms/NewComputeForm.js";
import { HelpOverlay } from "./components/HelpOverlay.js";
import { TABS } from "./components/TabBar.js";

export function App() {
  return (
    <FocusProvider>
      <AppInner />
    </FocusProvider>
  );
}

function AppInner() {
  const { exit } = useApp();
  const store = useStore();
  const focus = useFocus();
  const sessionsAsync = useAsync(store.refresh);
  const agentsAsync = useAsync(store.refresh);
  const historyAsync = useAsync(store.refresh);
  const computeAsync = useAsync(store.refresh);

  // Multi-instance registration
  const instanceRef = useRef<{ stop: () => void; isPrimary: () => boolean } | null>(null);
  useEffect(() => {
    const id = `tui-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    instanceRef.current = core.registerInstance(id);
    return () => { instanceRef.current?.stop(); };
  }, []);

  // Restore persisted tab on mount
  const savedState = useMemo(() => core.loadUiState(), []);
  const [tab, setTab] = useState<Tab>(() => {
    const saved = TABS[savedState.activeTab];
    return saved ?? "sessions";
  });

  // Persist tab changes
  useEffect(() => {
    const tabIndex = TABS.indexOf(tab);
    core.saveUiState({ activeTab: tabIndex >= 0 ? tabIndex : 0 });
  }, [tab]);

  const [showForm, setShowForm] = useState<string | null>(null);
  const [sessionPrefill, setSessionPrefill] = useState<SessionPrefill | undefined>();
  const [eventLogExpanded, setEventLogExpanded] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [selectedSession, setSelectedSession] = useState<import("../core/store.js").Session | null>(null);
  const [pane, setPane] = useState<Pane>("left");
  const { stdout } = useStdout();
  const termHeight = stdout?.rows ?? 40;

  const switchTab = useCallback((t: Tab) => { setTab(t); setPane("left"); }, []);

  // Push/pop focus when App-level form opens/closes
  useEffect(() => {
    if (showForm) focus.push("form");
    else focus.pop("form");
  }, [showForm]);

  // Auto-focus right pane when any child takes focus
  useEffect(() => {
    if (!focus.appActive) setPane("right");
  }, [focus.appActive]);

  // Active tab's async state
  const asyncState = tab === "agents" ? agentsAsync : tab === "history" ? historyAsync : tab === "compute" ? computeAsync : sessionsAsync;

  const takeSnapshot = useCallback(() => {
    if (!process.env.TMUX) return;
    asyncState.run("Copying screen...", async () => {
      await new Promise<void>((resolve) => {
        execFile("tmux", ["capture-pane", "-S", "-"], ((_err) => {
          execFile("tmux", ["save-buffer", "-"], { encoding: "utf-8" }, (err, content) => {
            if (!err && content) {
              execFile("pbcopy", [], ((() => resolve()) as any)).stdin?.end(content);
            } else {
              resolve();
            }
          });
        }) as any);
      });
    });
  }, [asyncState]);

  // Push/pop focus for help overlay
  useEffect(() => {
    if (showHelp) focus.push("help");
    else focus.pop("help");
  }, [showHelp]);

  // App-level shortcuts only fire when no child owns focus
  useInput((input, key) => {
    if (!focus.appActive) return;

    if (input === "q") { exit(); return; }
    if (input === "?") { setShowHelp(true); return; }
    if (input === "p") { takeSnapshot(); return; }

    if (key.tab) {
      setPane(p => p === "left" ? "right" : "left");
      return;
    }
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
    } else if (input === "7") {
      switchTab("costs");
    }
  });

  return (
    <Box flexDirection="column" height={termHeight}>
      <TabBar active={tab} loading={asyncState.loading || store.initialLoading} loadingLabel={store.initialLoading ? "Loading..." : asyncState.label} />

      {tab === "sessions" ? (
        <SessionsTab
          {...store}
          pane={pane}
          asyncState={sessionsAsync}
          onShowForm={() => setShowForm("session")}
          onSelectionChange={setSelectedSession}

          formOverlay={showForm === "session" ? (
            <NewSessionForm
              store={store}
              asyncState={sessionsAsync}
              onDone={() => { setShowForm(null); setSessionPrefill(undefined); store.refresh(); }}
              prefill={sessionPrefill}
            />
          ) : undefined}
        />
      ) : tab === "agents" ? (
        <AgentsTab
          {...store}
          pane={pane}
          asyncState={agentsAsync}
          refresh={store.refresh}
        />
      ) : tab === "tools" ? (
        <ToolsTab
          pane={pane}
          asyncState={sessionsAsync}
          refresh={store.refresh}
          onUseRecipe={(instance) => {
            sessionsAsync.run("Creating session...", async () => {
              core.startSession({
                summary: instance.summary,
                repo: instance.repo,
                flow: instance.flow,
                agent: instance.agent,
                compute_name: instance.compute,
                group_name: instance.group,
              });
              store.refresh();
              switchTab("sessions");
            });
          }}
        />
      ) : tab === "flows" ? (
        <FlowsTab {...store} pane={pane} />
      ) : tab === "history" ? (
        <HistoryTab
          {...store}
          pane={pane}
          asyncState={historyAsync}

          onImport={(prefill) => {
            setSessionPrefill(prefill);
            setShowForm("session");
            switchTab("sessions");
          }}
        />
      ) : tab === "compute" ? (
        <ComputeTab
          {...store}
          pane={pane}
          asyncState={computeAsync}
          onShowForm={() => setShowForm("compute")}
          formOverlay={showForm === "compute" ? (
            <NewComputeForm asyncState={computeAsync} onDone={() => { setShowForm(null); store.refresh(); }} />
          ) : undefined}
        />
      ) : tab === "costs" ? (
        <CostsTab />
      ) : null}

      {showHelp && (
        <HelpOverlay onClose={() => setShowHelp(false)} />
      )}

      <EventLog
        expanded={eventLogExpanded}
      />

      <StatusBar
        tab={tab}
        sessions={store.sessions}
        selectedSession={selectedSession}
        loading={asyncState.loading}
        error={asyncState.error}
        label={asyncState.label}
        pane={pane}
        overlay={focus.owner}
      />
    </Box>
  );
}
