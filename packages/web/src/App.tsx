import "./styles.css";
import { useState } from "react";
import { createRoot } from "react-dom/client";
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
import { Button } from "./components/ui/button.js";

function App() {
  const [view, setView] = useState("sessions");
  const [toast, setToast] = useState<{ msg: string; type: string } | null>(null);
  const readOnly = document.getElementById("root")?.dataset.readonly === "true";

  function showToast(msg: string, type: string) { setToast({ msg, type }); }

  return (
    <>
      {view === "sessions" && (
        <SessionsPage view={view} onNavigate={setView} readOnly={readOnly} onToast={showToast} />
      )}
      {view === "agents" && (
        <Layout view={view} onNavigate={setView} readOnly={readOnly} title="Agents" padded={false}
          headerRight={!readOnly ? <Button size="sm" onClick={() => document.dispatchEvent(new CustomEvent("ark:new-item"))}>+ New Agent</Button> : undefined}>
          <AgentsView />
        </Layout>
      )}
      {view === "tools" && (
        <ToolsPage view={view} onNavigate={setView} readOnly={readOnly} />
      )}
      {view === "flows" && (
        <Layout view={view} onNavigate={setView} readOnly={readOnly} title="Flows" padded={false}>
          <FlowsView />
        </Layout>
      )}
      {view === "history" && (
        <Layout view={view} onNavigate={setView} readOnly={readOnly} title="History">
          <HistoryView />
        </Layout>
      )}
      {view === "compute" && (
        <Layout view={view} onNavigate={setView} readOnly={readOnly} title="Compute" padded={false}
          headerRight={!readOnly ? <Button size="sm" onClick={() => document.dispatchEvent(new CustomEvent("ark:new-item"))}>+ New Compute</Button> : undefined}>
          <ComputeView />
        </Layout>
      )}
      {view === "schedules" && (
        <Layout view={view} onNavigate={setView} readOnly={readOnly} title="Schedules" padded={false}
          headerRight={!readOnly ? <Button size="sm" onClick={() => document.dispatchEvent(new CustomEvent("ark:new-item"))}>+ New Schedule</Button> : undefined}>
          <ScheduleView />
        </Layout>
      )}
      {view === "memory" && (
        <Layout view={view} onNavigate={setView} readOnly={readOnly} title="Memory"
          headerRight={!readOnly ? <Button size="sm" onClick={() => document.dispatchEvent(new CustomEvent("ark:new-item"))}>+ Add Memory</Button> : undefined}>
          <MemoryView />
        </Layout>
      )}
      {view === "costs" && (
        <Layout view={view} onNavigate={setView} readOnly={readOnly} title="Costs">
          <CostsView />
        </Layout>
      )}
      {toast && (
        <Toast
          key={Date.now()}
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
root.render(<App />);
