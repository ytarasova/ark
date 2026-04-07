import "./styles.css";
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
import { cn } from "./lib/utils.js";

function Toast({ message, type, onDone }: { message: string; type: string; onDone: () => void }) {
  useEffect(() => {
    const t = setTimeout(onDone, 3000);
    return () => clearTimeout(t);
  }, []);
  return (
    <div className={cn(
      "fixed bottom-5 right-5 px-[18px] py-2.5 bg-card border border-border rounded-xl text-foreground text-[13px] font-medium z-[300] shadow-[0_4px_20px_rgba(0,0,0,0.4)] animate-[slide-up_300ms_cubic-bezier(0.32,0.72,0,1)] flex items-center gap-2",
      type === "success" && "border-l-[3px] border-l-emerald-400",
      type === "error" && "border-l-[3px] border-l-red-400",
    )}>
      {type === "success" && <span className="text-emerald-400 font-bold">{"\u2713"}</span>}
      {type === "error" && <span className="text-red-400 font-bold">{"\u2717"}</span>}
      {message}
    </div>
  );
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
    <div className="grid grid-cols-[200px_1fr] h-screen bg-transparent max-md:grid-cols-[48px_1fr]">
      <Sidebar activeView={view} onNavigate={setView} readOnly={readOnly} />
      <div className="overflow-y-auto flex flex-col bg-background">
        <div className="h-12 px-5 border-b border-border flex items-center justify-between bg-background/80 backdrop-blur-xl sticky top-0 z-10 shrink-0">
          <div className="flex items-center gap-3">
            <h1 className="text-[15px] font-semibold text-foreground">{viewTitles[view] || "Dashboard"}</h1>
            {view === "sessions" && (
              <div className="flex gap-2 text-xs font-mono">
                {runningCount > 0 && <span className="text-emerald-400">{runningCount}</span>}
                {waitingCount > 0 && <span className="text-amber-400">{waitingCount}</span>}
                {failedCount > 0 && <span className="text-red-400">{failedCount}</span>}
              </div>
            )}
          </div>
          <div className="flex items-center gap-3">
            {view === "sessions" && (
              <span className="text-xs font-mono text-muted-foreground">{sessions.length}</span>
            )}
            {view === "sessions" && !readOnly && (
              <button
                className="px-3.5 py-1.5 rounded-lg text-[12px] font-medium bg-primary text-primary-foreground hover:bg-primary/90 active:scale-[0.97] transition-all duration-150"
                onClick={() => setShowNew(true)}
              >
                + New Session
              </button>
            )}
          </div>
        </div>
        <div className={cn(
          "flex-1 overflow-y-auto flex flex-col",
          ["agents","tools","flows","compute","schedules"].includes(view) ? "" : "p-5 px-6"
        )}>
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
