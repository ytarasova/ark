import { useState } from "react";
import { Layout } from "../components/Layout.js";
import { SessionList } from "../components/SessionList.js";
import { SessionDetail } from "../components/SessionDetail.js";
import { NewSessionModal } from "../components/NewSessionModal.js";
import { useSessions } from "../hooks/useSessions.js";
import { api } from "../hooks/useApi.js";
import { Button } from "../components/ui/button.js";

interface SessionsPageProps {
  view: string;
  onNavigate: (view: string) => void;
  readOnly: boolean;
  onToast: (msg: string, type: string) => void;
}

export function SessionsPage({ view, onNavigate, readOnly, onToast }: SessionsPageProps) {
  const { sessions, groups, refresh } = useSessions();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [groupFilter, setGroupFilter] = useState("");
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
        <div className="flex gap-1.5">
          {runningCount > 0 && <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-emerald-500/15 text-emerald-400 border border-emerald-500/20"><span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />{runningCount} running</span>}
          {waitingCount > 0 && <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-amber-500/15 text-amber-400 border border-amber-500/20"><span className="w-1.5 h-1.5 rounded-full bg-amber-400" />{waitingCount} waiting</span>}
          {failedCount > 0 && <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-red-500/15 text-red-400 border border-red-500/20"><span className="w-1.5 h-1.5 rounded-full bg-red-400" />{failedCount} failed</span>}
        </div>
      }
      headerRight={!readOnly ? <Button size="sm" onClick={() => { setShowNew(true); setSelectedId(null); }}>+ New Session</Button> : undefined}
    >
      <div className="grid grid-cols-[minmax(300px,2fr)_3fr] h-full">
        {/* Left: session list */}
        <div className="border-r border-border overflow-y-auto p-4">
          <SessionList
            sessions={sessions} selectedId={selectedId} onSelect={(id) => { setSelectedId(id); setShowNew(false); }}
            filter={filter} onFilterChange={setFilter}
            search={search} onSearchChange={setSearch}
            groups={groups} groupFilter={groupFilter} onGroupFilter={setGroupFilter}
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
