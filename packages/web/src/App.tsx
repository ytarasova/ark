import { useState, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { Sidebar } from "./components/Sidebar.js";
import { SessionList } from "./components/SessionList.js";
import { SessionDetail } from "./components/SessionDetail.js";
import { CostsView } from "./components/CostsView.js";
import { StatusView } from "./components/StatusView.js";
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

  const viewTitles: Record<string, string> = { sessions: "Sessions", costs: "Costs", status: "System Status" };

  return (
    <div className="app">
      <Sidebar activeView={view} onNavigate={setView} readOnly={readOnly} />
      <div className="main">
        <div className="main-header">
          <div className="main-title">{viewTitles[view] || "Dashboard"}</div>
          <div style={{ color: "#787fa0", fontSize: 13 }}>{sessions.length} sessions</div>
        </div>
        <div className="main-body">
          {view === "sessions" && (
            <SessionList
              sessions={sessions} selectedId={selectedId} onSelect={setSelectedId}
              filter={filter} onFilterChange={setFilter}
              search={search} onSearchChange={setSearch}
              groups={groups} groupFilter={groupFilter} onGroupFilter={setGroupFilter}
              onNewSession={() => setShowNew(true)} readOnly={readOnly}
            />
          )}
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
