import { useState } from "react";
import { Layout } from "../components/Layout.js";
import { SessionList } from "../components/SessionList.js";
import { SessionDetail } from "../components/SessionDetail.js";
import { NewSessionModal } from "../components/NewSessionModal.js";
import { useSessions } from "../hooks/useSessions.js";
import { api } from "../hooks/useApi.js";
import { Button } from "../components/ui/button.js";
import { Input } from "../components/ui/input.js";
import { Search } from "lucide-react";

const FILTERS = ["all", "running", "waiting", "stopped", "failed", "completed"];

interface SessionsPageProps {
  view: string;
  onNavigate: (view: string) => void;
  readOnly: boolean;
  onToast: (msg: string, type: string) => void;
}

export function SessionsPage({ view, onNavigate, readOnly, onToast }: SessionsPageProps) {
  const { sessions, groups: _groups, refresh } = useSessions();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [groupFilter, _setGroupFilter] = useState("");
  const [showNew, setShowNew] = useState(false);

  const runningCount = sessions.filter(s => s.status === "running").length;
  const waitingCount = sessions.filter(s => s.status === "waiting").length;
  const failedCount = sessions.filter(s => s.status === "failed").length;

  async function handleNewSession(form: any) {
    const shouldDispatch = form.dispatch;
    const res = await api.createSession(form);
    if (res.ok) {
      if (shouldDispatch && res.id) {
        try {
          await api.dispatch(res.id);
          onToast("Session created and dispatched", "success");
        } catch {
          onToast("Session created but dispatch failed", "error");
        }
      } else {
        onToast("Session created", "success");
      }
      setShowNew(false);
      setSelectedId(res.id || null);
      refresh();
    } else {
      onToast(res.message || "Failed to create session", "error");
    }
  }

  return (
    <Layout
      view={view} onNavigate={onNavigate} readOnly={readOnly} title="Sessions"
      padded={false}
      headerLeft={
        <div className="flex gap-1.5 items-center">
          {runningCount > 0 && <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-emerald-500/15 text-emerald-400 border border-emerald-500/20"><span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />{runningCount}</span>}
          {waitingCount > 0 && <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-amber-500/15 text-amber-400 border border-amber-500/20"><span className="w-1.5 h-1.5 rounded-full bg-amber-400" />{waitingCount}</span>}
          {failedCount > 0 && <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-red-500/15 text-red-400 border border-red-500/20"><span className="w-1.5 h-1.5 rounded-full bg-red-400" />{failedCount}</span>}
          <div className="ml-2 flex gap-1">
            {FILTERS.map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={`px-2 py-0.5 text-[10px] font-medium rounded-md transition-colors ${filter === f ? "bg-secondary text-foreground" : "text-muted-foreground hover:text-foreground"}`}
              >
                {f === "all" ? "All" : f.charAt(0).toUpperCase() + f.slice(1)}
              </button>
            ))}
          </div>
        </div>
      }
      headerRight={
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              className="w-40 h-7 pl-7 pr-2 text-[11px] bg-secondary"
              placeholder="Search..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          {!readOnly && <Button size="sm" onClick={() => { setShowNew(true); setSelectedId(null); }}>+ New Session</Button>}
        </div>
      }
    >
      <div className="grid grid-cols-[260px_1fr] overflow-hidden h-full">
        {/* Left: session list */}
        <div className="border-r border-border overflow-y-auto">
          <SessionList
            sessions={sessions} selectedId={selectedId} onSelect={(id) => { setSelectedId(id); setShowNew(false); }}
            filter={filter} search={search} groupFilter={groupFilter}
          />
        </div>
        {/* Right: detail panel or create form */}
        <div className="overflow-y-auto bg-background">
          {showNew ? (
            <NewSessionModal
              onClose={() => setShowNew(false)}
              onSubmit={handleNewSession}
            />
          ) : selectedId ? (
            <SessionDetail
              key={selectedId}
              sessionId={selectedId}
              onClose={() => setSelectedId(null)}
              onToast={onToast}
              readOnly={readOnly}
            />
          ) : (
            <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
              Select a session or create a new one
            </div>
          )}
        </div>
      </div>
    </Layout>
  );
}
