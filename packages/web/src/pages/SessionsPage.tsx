import { useState, useMemo, useEffect, useCallback, useRef } from "react";
import { Layout } from "../components/Layout.js";
import { SessionListPanel } from "../components/SessionList.js";
import { SessionDetail } from "../components/SessionDetail.js";
import { NewSessionModal } from "../components/NewSessionModal.js";
import { DashboardView } from "../components/DashboardView.js";
import { useSessions } from "../hooks/useSessions.js";
import { api } from "../hooks/useApi.js";
import type { DaemonStatus } from "../hooks/useDaemonStatus.js";

interface SessionsPageProps {
  view: string;
  onNavigate: (view: string) => void;
  readOnly: boolean;
  onToast: (msg: string, type: string) => void;
  daemonStatus?: DaemonStatus | null;
  initialSelectedId?: string | null;
  onSelectedChange?: (id: string | null) => void;
  initialTab?: string | null;
  onTabChange?: (tab: string | null) => void;
}

export function SessionsPage({
  view,
  onNavigate,
  readOnly,
  onToast,
  daemonStatus,
  initialSelectedId,
  onSelectedChange,
  initialTab,
  onTabChange,
}: SessionsPageProps) {
  const [selectedId, setSelectedIdInternal] = useState<string | null>(initialSelectedId ?? null);
  const setSelectedId = useCallback(
    (id: string | null) => {
      setSelectedIdInternal(id);
      onSelectedChange?.(id);
    },
    [onSelectedChange],
  );
  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");
  const serverStatus = filter === "archived" ? "archived" : undefined;
  const { sessions, refresh } = useSessions(serverStatus);
  const [showNew, setShowNew] = useState(false);

  // ── Unread counts ──────────────────────────────────────────────────────────
  const [unreadCounts, setUnreadCounts] = useState<Record<string, number>>({});
  const unreadTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchUnreadCounts = useCallback(() => {
    api
      .getUnreadCounts()
      .then(setUnreadCounts)
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetchUnreadCounts();
    unreadTimerRef.current = setInterval(fetchUnreadCounts, 10_000);
    return () => {
      if (unreadTimerRef.current) clearInterval(unreadTimerRef.current);
    };
  }, [fetchUnreadCounts]);

  const totalUnread = useMemo(() => {
    let sum = 0;
    for (const v of Object.values(unreadCounts)) sum += v;
    return sum;
  }, [unreadCounts]);

  // Load flow stages for pipeline visualization
  const [flowStagesMap, setFlowStagesMap] = useState<Record<string, any[]>>({});

  useEffect(() => {
    // Collect unique flow names from sessions
    const flowNames = new Set<string>();
    for (const s of sessions || []) {
      const f = s.pipeline || s.flow;
      if (f && !flowStagesMap[f]) flowNames.add(f);
    }
    for (const name of flowNames) {
      api
        .getFlowDetail(name)
        .then((d: any) => {
          if (d.stages?.length) {
            setFlowStagesMap((prev) => ({ ...prev, [name]: d.stages }));
          }
        })
        .catch(() => {});
    }
  }, [sessions]);

  // Compute filtered sessions for keyboard navigation
  const filteredSessions = useMemo(() => {
    let list = sessions || [];
    if (filter !== "all" && filter !== "archived") list = list.filter((s) => s.status === filter);
    if (search) {
      const q = search.toLowerCase();
      list = list.filter(
        (s) =>
          (s.summary || "").toLowerCase().includes(q) ||
          (s.id || "").toLowerCase().includes(q) ||
          (s.agent || "").toLowerCase().includes(q),
      );
    }
    return list;
  }, [sessions, filter, search]);

  // Keyboard shortcuts for session navigation
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

      switch (e.key) {
        case "j": {
          e.preventDefault();
          if (filteredSessions.length === 0) break;
          const idx = selectedId ? filteredSessions.findIndex((s) => s.id === selectedId) : -1;
          const next = Math.min(idx + 1, filteredSessions.length - 1);
          setSelectedId(filteredSessions[next].id);
          setShowNew(false);
          break;
        }
        case "k": {
          e.preventDefault();
          if (filteredSessions.length === 0) break;
          const idx = selectedId ? filteredSessions.findIndex((s) => s.id === selectedId) : filteredSessions.length;
          const prev = Math.max(idx - 1, 0);
          setSelectedId(filteredSessions[prev].id);
          setShowNew(false);
          break;
        }
        case "n": {
          if (readOnly) break;
          e.preventDefault();
          setShowNew(true);
          setSelectedId(null);
          break;
        }
        case "Escape": {
          if (showNew) {
            setShowNew(false);
            break;
          }
          if (selectedId) {
            setSelectedId(null);
            break;
          }
          break;
        }
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [filteredSessions, selectedId, readOnly, showNew]);

  async function handleNewSession(form: any) {
    const shouldDispatch = form.dispatch;
    const res = await api.createSession(form);
    if (res.ok) {
      if (shouldDispatch && res.session?.id) {
        try {
          await new Promise((r) => setTimeout(r, 500));
          await api.dispatch(res.session.id);
          onToast(`Session ${res.session.id} created and dispatched`, "success");
        } catch {
          try {
            await new Promise((r) => setTimeout(r, 1000));
            await api.dispatch(res.session.id);
            onToast(`Session ${res.session.id} created and dispatched (retry)`, "success");
          } catch {
            onToast(
              `Session ${res.session.id} created but dispatch failed. Check that the conductor is running: ark server daemon start`,
              "error",
            );
          }
        }
      } else {
        onToast(`Session ${res.session?.id || ""} created`, "success");
      }
      setShowNew(false);
      setSelectedId(res.session?.id || null);
      refresh();
    } else {
      onToast(`Failed to create session: ${res.message || "unknown error"}`, "error");
    }
  }

  return (
    <Layout
      view={view}
      onNavigate={onNavigate}
      readOnly={readOnly}
      daemonStatus={daemonStatus}
      totalUnread={totalUnread}
    >
      {/* Session List Panel */}
      <SessionListPanel
        sessions={sessions}
        selectedId={selectedId}
        onSelect={(id) => {
          const next = id === selectedId ? null : id;
          setSelectedId(next);
          setShowNew(false);
          if (next && unreadCounts[next]) {
            api.markRead(next).then(() => {
              setUnreadCounts((prev) => {
                const copy = { ...prev };
                delete copy[next];
                return copy;
              });
            });
          }
        }}
        filter={filter}
        onFilterChange={setFilter}
        search={search}
        onSearchChange={setSearch}
        onNewSession={() => {
          setShowNew(true);
          setSelectedId(null);
        }}
        readOnly={readOnly}
        flowStagesMap={flowStagesMap}
        unreadCounts={unreadCounts}
      />

      {/* Center Panel */}
      {showNew ? (
        <div className="flex-1 overflow-y-auto bg-[var(--bg)]">
          <NewSessionModal
            onClose={() => setShowNew(false)}
            onSubmit={handleNewSession}
            daemonOnline={daemonStatus?.conductor?.online !== false}
          />
        </div>
      ) : selectedId ? (
        <SessionDetail
          key={selectedId}
          sessionId={selectedId}
          onToast={onToast}
          readOnly={readOnly}
          initialTab={initialTab}
          onTabChange={onTabChange}
        />
      ) : (
        <DashboardView onNavigate={onNavigate} readOnly={readOnly} daemonStatus={daemonStatus} />
      )}
    </Layout>
  );
}
