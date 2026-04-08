import "./styles.css";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { queryClient, QueryClientProvider } from "./providers/QueryProvider.js";
import { Layout } from "./components/Layout.js";
import { Toast } from "./components/Toast.js";
import { SessionsPage } from "./pages/SessionsPage.js";
import { ToolsPage } from "./pages/ToolsPage.js";
import { AgentsView } from "./components/AgentsView.js";
import { FlowsView } from "./components/FlowsView.js";
import { HistoryView } from "./components/HistoryView.js";
import { ComputeView } from "./components/ComputeView.js";
import { ScheduleView } from "./components/ScheduleView.js";
import { MemoryView } from "./components/MemoryView.js";
import { CostsView } from "./components/CostsView.js";
import { SettingsView } from "./components/SettingsView.js";
import { Button } from "./components/ui/button.js";
import { cn } from "./lib/utils.js";
import { Database, FileText } from "lucide-react";

const READ_ONLY = document.getElementById("root")?.dataset.readonly === "true";

function App() {
  const [view, setView] = useState("sessions");
  const [toast, setToast] = useState<{ msg: string; type: string } | null>(null);
  const [toastKey, setToastKey] = useState(0);
  const readOnly = READ_ONLY;

  // Per-view "new item" state
  const [showNewAgent, setShowNewAgent] = useState(false);
  const [showNewFlow, setShowNewFlow] = useState(false);
  const [showNewCompute, setShowNewCompute] = useState(false);
  const [showNewSchedule, setShowNewSchedule] = useState(false);
  const [addMemoryCounter, setAddMemoryCounter] = useState(0);

  // History view mode
  const [historyMode, setHistoryMode] = useState<"sessions" | "transcripts">("sessions");

  function showToast(msg: string, type: string) {
    setToast({ msg, type });
    setToastKey((k) => k + 1);
  }

  return (
    <>
      {view === "sessions" && (
        <SessionsPage view={view} onNavigate={setView} readOnly={readOnly} onToast={showToast} />
      )}
      {view === "agents" && (
        <Layout view={view} onNavigate={setView} readOnly={readOnly} title="Agents" padded={false}
          headerRight={!readOnly ? <Button size="sm" onClick={() => setShowNewAgent(true)}>+ New Agent</Button> : undefined}>
          <AgentsView showCreate={showNewAgent} onCloseCreate={() => setShowNewAgent(false)} />
        </Layout>
      )}
      {view === "tools" && (
        <ToolsPage view={view} onNavigate={setView} readOnly={readOnly} />
      )}
      {view === "flows" && (
        <Layout view={view} onNavigate={setView} readOnly={readOnly} title="Flows" padded={false}
          headerRight={!readOnly ? <Button size="sm" onClick={() => setShowNewFlow(true)}>+ New Flow</Button> : undefined}>
          <FlowsView showCreate={showNewFlow} onCloseCreate={() => setShowNewFlow(false)} />
        </Layout>
      )}
      {view === "history" && (
        <Layout view={view} onNavigate={setView} readOnly={readOnly} title="History"
          headerLeft={
            <div className="flex gap-1 ml-2">
              {(["sessions", "transcripts"] as const).map(m => (
                <button key={m} onClick={() => setHistoryMode(m)} className={cn(
                  "px-3 py-1 text-xs font-medium rounded-md transition-colors inline-flex items-center gap-1.5",
                  historyMode === m ? "bg-secondary text-foreground" : "text-muted-foreground hover:text-foreground"
                )}>
                  {m === "sessions" ? <Database size={12} /> : <FileText size={12} />}
                  {m.charAt(0).toUpperCase() + m.slice(1)}
                </button>
              ))}
            </div>
          }>
          <HistoryView mode={historyMode} onModeChange={setHistoryMode} onSelectSession={() => setView("sessions")} />
        </Layout>
      )}
      {view === "compute" && (
        <Layout view={view} onNavigate={setView} readOnly={readOnly} title="Compute" padded={false}
          headerRight={!readOnly ? <Button size="sm" onClick={() => setShowNewCompute(true)}>+ New Compute</Button> : undefined}>
          <ComputeView showCreate={showNewCompute} onCloseCreate={() => setShowNewCompute(false)} />
        </Layout>
      )}
      {view === "schedules" && (
        <Layout view={view} onNavigate={setView} readOnly={readOnly} title="Schedules" padded={false}
          headerRight={!readOnly ? <Button size="sm" onClick={() => setShowNewSchedule(true)}>+ New Schedule</Button> : undefined}>
          <ScheduleView showCreate={showNewSchedule} onCloseCreate={() => setShowNewSchedule(false)} />
        </Layout>
      )}
      {view === "memory" && (
        <Layout view={view} onNavigate={setView} readOnly={readOnly} title="Memory" padded={false}
          headerRight={!readOnly ? <Button size="sm" onClick={() => setAddMemoryCounter(c => c + 1)}>+ Add Memory</Button> : undefined}>
          <MemoryView addRequested={addMemoryCounter} />
        </Layout>
      )}
      {view === "costs" && (
        <Layout view={view} onNavigate={setView} readOnly={readOnly} title="Costs">
          <CostsView />
        </Layout>
      )}
      {view === "settings" && (
        <Layout view={view} onNavigate={setView} readOnly={readOnly} title="Settings">
          <SettingsView />
        </Layout>
      )}
      {toast && (
        <Toast
          key={toastKey}
          message={toast.msg}
          type={toast.type}
          onDone={() => setToast(null)}
        />
      )}
    </>
  );
}

// ---- Mount ----
const root = createRoot(document.getElementById("root")!);
root.render(
  <QueryClientProvider client={queryClient}>
    <App />
  </QueryClientProvider>
);
