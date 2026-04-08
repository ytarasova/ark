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
    const res = await api.createSession(form);
    if (res.ok) {
      onToast("Session created", "success");
      setShowNew(false);
      refresh();
    } else {
      onToast(res.message || "Failed to create session", "error");
    }
  }

  return (
    <>
      <Layout
        view={view} onNavigate={onNavigate} readOnly={readOnly} title="Sessions"
        headerLeft={
          <div className="flex gap-2 text-xs font-mono">
            {runningCount > 0 && <span className="text-emerald-400">{runningCount}</span>}
            {waitingCount > 0 && <span className="text-amber-400">{waitingCount}</span>}
            {failedCount > 0 && <span className="text-red-400">{failedCount}</span>}
          </div>
        }
        headerRight={<>
          <span className="text-xs font-mono text-muted-foreground">{sessions.length}</span>
          {!readOnly && <Button size="sm" onClick={() => setShowNew(true)}>+ New Session</Button>}
        </>}
      >
        <SessionList
          sessions={sessions} selectedId={selectedId} onSelect={setSelectedId}
          filter={filter} onFilterChange={setFilter}
          search={search} onSearchChange={setSearch}
          groups={groups} groupFilter={groupFilter} onGroupFilter={setGroupFilter}
        />
      </Layout>
      {selectedId && (
        <SessionDetail
          key={selectedId}
          sessionId={selectedId}
          onClose={() => setSelectedId(null)}
          onToast={onToast}
          readOnly={readOnly}
        />
      )}
      {showNew && (
        <NewSessionModal
          onClose={() => setShowNew(false)}
          onSubmit={handleNewSession}
        />
      )}
    </>
  );
}
