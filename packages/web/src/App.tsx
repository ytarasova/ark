import { useState, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { Sidebar } from "./components/Sidebar.js";
import { SessionList } from "./components/SessionList.js";
import { SessionDetail } from "./components/SessionDetail.js";
import { CostsView } from "./components/CostsView.js";
import { StatusView } from "./components/StatusView.js";
import { AgentsView } from "./components/AgentsView.js";
import { ToolsView } from "./components/ToolsView.js";
import { FlowsView } from "./components/FlowsView.js";
import { ComputeView } from "./components/ComputeView.js";
import { ScheduleView } from "./components/ScheduleView.js";
import { HistoryView } from "./components/HistoryView.js";
import { MemoryView } from "./components/MemoryView.js";
import { NewSessionModal } from "./components/NewSessionModal.js";
import { api } from "./hooks/useApi.js";
import { useSse } from "./hooks/useSse.js";

function Toast({ message, type, onDone }: { message: string; type: string; onDone: () => void }) {
  useEffect(() => {
    const t = setTimeout(onDone, 3000);
    return () => clearTimeout(t);
  }, []);
  return <div className={`toast toast-${type}`}>{message}</div>;
}

function App() {
  const [view, setView] = useState("sessions");
  const [sessions, setSessions] = useState<any[]>([]);
  const [groups, setGroups] = useState<string[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [groupFilter, setGroupFilter] = useState("");
  const [showNew, setShowNew] = useState(false);
  const [toast, setToast] = useState<{ msg: string; type: string } | null>(null);

  // Detect read-only from a data attribute on root (set by server)
  const readOnly = document.getElementById("root")?.dataset.readonly === "true";

  function showToast(msg: string, type: string) { setToast({ msg, type }); }

  // Load sessions
  useEffect(() => {
    api.getSessions().then(setSessions);
    api.getGroups().then(setGroups);
  }, []);

  // SSE live updates
  const sseData = useSse<any[]>("/api/events/stream");
  useEffect(() => {
    if (!sseData) return;
    setSessions((prev) => {
      const map = new Map(prev.map((s) => [s.id, s]));
      for (const u of sseData) {
        const existing = map.get(u.id);
        if (existing) {
          map.set(u.id, { ...existing, status: u.status, summary: u.summary, agent: u.agent, repo: u.repo, group_name: u.group, updated_at: u.updated });
        } else {
          map.set(u.id, { id: u.id, status: u.status, summary: u.summary, agent: u.agent, repo: u.repo, group_name: u.group, updated_at: u.updated });
        }
      }
      return Array.from(map.values());
    });
  }, [sseData]);

  async function handleNewSession(form: any) {
    const res = await api.createSession(form);
    if (res.ok) {
      showToast("Session created", "success");
      setShowNew(false);
      const data = await api.getSessions();
      setSessions(data);
    } else {
      showToast(res.message || "Failed to create session", "error");
    }
  }

  const viewTitles: Record<string, string> = {
    sessions: "Sessions", agents: "Agents", tools: "Tools",
    flows: "Flows", history: "History", compute: "Compute",
    schedules: "Schedules", memory: "Memory", costs: "Costs", status: "System",
  };

  // Inline status counts for sessions view (only non-zero)
  const runningCount = sessions.filter(s => s.status === "running").length;
  const waitingCount = sessions.filter(s => s.status === "waiting").length;
  const failedCount = sessions.filter(s => s.status === "failed").length;

  return (
    <div className="app">
      <Sidebar activeView={view} onNavigate={setView} readOnly={readOnly} />
      <div className="main">
        <div className="main-header">
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div className="main-title">{viewTitles[view] || "Dashboard"}</div>
            {view === "sessions" && (
              <div style={{ display: "flex", gap: 8, fontSize: 11, fontFamily: "var(--mono)" }}>
                {runningCount > 0 && <span style={{ color: "var(--green)" }}>{runningCount}</span>}
                {waitingCount > 0 && <span style={{ color: "var(--yellow)" }}>{waitingCount}</span>}
                {failedCount > 0 && <span style={{ color: "var(--red)" }}>{failedCount}</span>}
              </div>
            )}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 11, fontFamily: "var(--mono)", color: "var(--label-quaternary)" }}>
              {sessions.length}
            </span>
            {view === "sessions" && !readOnly && (
              <button className="btn btn-primary" onClick={() => setShowNew(true)} style={{ fontSize: 11 }}>
                + New Session
              </button>
            )}
          </div>
        </div>
        <div className="main-body">
          {view === "sessions" && (
            <SessionList
              sessions={sessions} selectedId={selectedId} onSelect={setSelectedId}
              filter={filter} onFilterChange={setFilter}
              search={search} onSearchChange={setSearch}
              groups={groups} groupFilter={groupFilter} onGroupFilter={setGroupFilter}
            />
          )}
          {view === "agents" && <AgentsView />}
          {view === "tools" && <ToolsView />}
          {view === "flows" && <FlowsView />}
          {view === "history" && <HistoryView />}
          {view === "compute" && <ComputeView />}
          {view === "schedules" && <ScheduleView />}
          {view === "memory" && <MemoryView />}
          {view === "costs" && <CostsView />}
          {view === "status" && <StatusView sessions={sessions} />}
        </div>
      </div>
      {/* Detail panel */}
      {selectedId && (
        <SessionDetail
          key={selectedId}
          sessionId={selectedId}
          onClose={() => setSelectedId(null)}
          onToast={showToast}
          readOnly={readOnly}
        />
      )}
      {/* New session modal */}
      {showNew && (
        <NewSessionModal
          onClose={() => setShowNew(false)}
          onSubmit={handleNewSession}
        />
      )}
      {/* Toast */}
      {toast && (
        <Toast
          key={Date.now()}
          message={toast.msg}
          type={toast.type}
          onDone={() => setToast(null)}
        />
      )}
    </div>
  );
}

// ---- Mount ----
const root = createRoot(document.getElementById("root")!);
root.render(<App />);
