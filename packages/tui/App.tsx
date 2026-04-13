import React, { useState, useCallback, useEffect, useMemo } from "react";
import { Box, useApp, useInput, useStdout } from "ink";
import { execFile } from "child_process";
import { join } from "path";
import { useArkClient } from "./hooks/useArkClient.js";
import { useArkStore } from "./hooks/useArkStore.js";
import { useAsync } from "./hooks/useAsync.js";
import { FocusProvider, useFocus } from "./hooks/useFocus.js";
import { TabBar } from "./components/TabBar.js";
import type { Tab } from "./components/TabBar.js";
import type { Pane } from "./components/SplitPane.js";
import { StatusBar } from "./components/StatusBar.js";
import { EventLog } from "./components/EventLog.js";
import {
  getOverlayHints,
  getRightPaneHints,
  getGenericHints,
  flattenHints,
} from "./helpers/statusBarHints.js";
import { SessionsTab, getSessionHints, EMPTY_SESSION_FILTERS, type SessionListFilters } from "./tabs/SessionsTab.js";
import { ComputeTab, getComputeHints } from "./tabs/ComputeTab.js";
import { AgentsTab, getAgentsHints } from "./tabs/AgentsTab.js";
import { FlowsTab, getFlowsHints } from "./tabs/FlowsTab.js";
import { HistoryTab, getHistoryHints } from "./tabs/HistoryTab.js";
import { ToolsTab, getToolsHints } from "./tabs/ToolsTab.js";
import { CostsTab, getCostsHints } from "./tabs/CostsTab.js";
import { SchedulesTab, getSchedulesHints } from "./tabs/SchedulesTab.js";
import { MemoryManager, getMemoryHints } from "./components/MemoryManager.js";
import { loadUiState, saveUiState } from "../core/state/ui-state.js";
import { NewSessionForm, type SessionPrefill } from "./forms/NewSessionForm.js";
import { NewComputeForm } from "./forms/NewComputeForm.js";
import { HelpOverlay } from "./components/HelpOverlay.js";
import { TABS } from "./components/TabBar.js";
import type { ConnectionStatus } from "../protocol/transport.js";

interface AppProps {
  /** Path to the Ark data directory, used for UI state persistence. */
  arkDir?: string;
}

export function App({ arkDir }: AppProps) {
  return (
    <FocusProvider>
      <AppInner arkDir={arkDir} />
    </FocusProvider>
  );
}

function AppInner({ arkDir: arkDirProp }: { arkDir?: string }) {
  const { exit } = useApp();
  const ark = useArkClient();
  const store = useArkStore();
  const focus = useFocus();
  const sessionsAsync = useAsync(store.refresh);
  const agentsAsync = useAsync(store.refresh);
  const flowsAsync = useAsync(store.refresh);
  const historyAsync = useAsync(store.refresh);
  const computeAsync = useAsync(store.refresh);

  const arkDir = arkDirProp ?? join(process.env.HOME ?? "/tmp", ".ark");

  // Connection status tracking for daemon/remote mode
  const [connStatus, setConnStatus] = useState<ConnectionStatus>("connected");
  useEffect(() => {
    return ark.onConnectionStatus(setConnStatus);
  }, [ark]);

  // Restore persisted tab on mount
  const savedState = useMemo(() => loadUiState(arkDir), [arkDir]);
  const [tab, setTab] = useState<Tab>(() => {
    const saved = TABS[savedState.activeTab];
    return saved ?? "sessions";
  });

  // Persist tab changes
  useEffect(() => {
    const tabIndex = TABS.indexOf(tab);
    saveUiState({ activeTab: tabIndex >= 0 ? tabIndex : 0 }, arkDir);
  }, [tab]);

  const [showForm, setShowForm] = useState<string | null>(null);
  const [sessionPrefill, setSessionPrefill] = useState<SessionPrefill | undefined>();
  const [eventLogExpanded, setEventLogExpanded] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [selectedSession, setSelectedSession] = useState<import("../types/index.js").Session | null>(null);
  const [sessionFilters, setSessionFilters] = useState<SessionListFilters>(EMPTY_SESSION_FILTERS);
  const [pane, setPane] = useState<Pane>("left");
  const { stdout } = useStdout();
  const termHeight = stdout?.rows ?? 40;

  const switchTab = useCallback((t: Tab) => { setTab(t); setPane("left"); }, []);

  // Push/pop focus when App-level form opens/closes
  useEffect(() => {
    if (showForm) focus.push("form");
    else focus.pop("form");
  }, [showForm]);

  // Auto-switch pane when a child takes focus (based on focus entry's target pane)
  useEffect(() => {
    if (!focus.appActive && focus.targetPane) setPane(focus.targetPane);
  }, [focus.appActive, focus.targetPane]);

  // Active tab's async state
  const asyncState = tab === "agents" ? agentsAsync : tab === "flows" ? flowsAsync : tab === "history" ? historyAsync : tab === "compute" ? computeAsync : sessionsAsync;

  const takeSnapshot = useCallback(() => {
    if (!process.env.TMUX) return;
    asyncState.run("Copying screen...", async () => {
      await new Promise<void>((resolve) => {
        execFile("tmux", ["capture-pane", "-S", "-"], (_err, _stdout, _stderr) => {
          execFile("tmux", ["save-buffer", "-"], { encoding: "utf-8" }, (err, content) => {
            if (!err && content) {
              execFile("pbcopy", [], (_e, _o, _se) => resolve()).stdin?.end(content);
            } else {
              resolve();
            }
          });
        });
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
    } else if (input >= "1" && input <= "9") {
      const tab = TABS[parseInt(input) - 1];
      if (tab) switchTab(tab);
    }
  });

  return (
    <Box flexDirection="column" height={termHeight}>
      <TabBar active={tab} loading={asyncState.loading || store.initialLoading} loadingLabel={store.initialLoading ? "Loading..." : asyncState.label} />

      <Box flexDirection="column" flexGrow={1}>
      {tab === "sessions" ? (
        <SessionsTab
          {...store}
          pane={pane}
          asyncState={sessionsAsync}
          onShowForm={() => setShowForm("session")}
          onSelectionChange={setSelectedSession}
          onFiltersChange={setSessionFilters}

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
              await ark.sessionStart({
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
        <FlowsTab {...store} pane={pane} asyncState={flowsAsync} refresh={store.refresh} />
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
      ) : tab === "memory" ? (
        <MemoryManager pane={pane} />
      ) : tab === "costs" ? (
        <CostsTab pane={pane} />
      ) : tab === "schedules" ? (
        <SchedulesTab pane={pane} />
      ) : null}
      </Box>

      {showHelp && (
        <HelpOverlay onClose={() => setShowHelp(false)} />
      )}

      <EventLog
        expanded={eventLogExpanded}
      />

      <StatusBar
        hints={useMemo(() =>
          focus.owner ? getOverlayHints(focus.owner)
          : pane === "right" ? getRightPaneHints(tab)
          : tab === "sessions" ? getSessionHints(selectedSession, sessionFilters)
          : tab === "agents" ? getAgentsHints()
          : tab === "tools" ? getToolsHints()
          : tab === "flows" ? getFlowsHints()
          : tab === "compute" ? getComputeHints()
          : tab === "history" ? getHistoryHints()
          : tab === "memory" ? getMemoryHints()
          : tab === "costs" ? getCostsHints()
          : tab === "schedules" ? getSchedulesHints()
          : getGenericHints(),
        [tab, pane, focus.owner, selectedSession, sessionFilters])}
        overlayBarText={focus.owner ? flattenHints(getOverlayHints(focus.owner)) : null}
        sessions={store.sessions}
        loading={asyncState.loading}
        error={asyncState.error}
        connectionStatus={connStatus}
      />
    </Box>
  );
}
