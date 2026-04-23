import { useState, useMemo, useEffect, useCallback, useRef } from "react";
import { Layout } from "../components/Layout.js";
import { SessionListPanel } from "../components/SessionList.js";
import { SessionDetail } from "../components/SessionDetail.js";
import { NewSessionModal } from "../components/NewSessionModal.js";
import { DashboardView } from "../components/DashboardView.js";
import { SessionStreamErrorBoundary } from "../components/ui/ErrorBoundary.js";
import { ConfirmDialog } from "../components/ui/ConfirmDialog.js";
import { useSessions } from "../hooks/useSessions.js";
import { api } from "../hooks/useApi.js";
import { ArrowLeft, Maximize2, Minimize2 } from "lucide-react";
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
  const [maximized, setMaximized] = useState(false);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [deletingBusy, setDeletingBusy] = useState(false);
  const setSelectedId = useCallback(
    (id: string | null) => {
      setSelectedIdInternal(id);
      onSelectedChange?.(id);
      if (!id) setMaximized(false);
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
      .catch((err) => {
        console.warn(
          `SessionsPage: getUnreadCounts failed (next 10s poll will retry):`,
          err instanceof Error ? err.message : err,
        );
      });
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
    // Collect unique flow names from sessions. We read `flowStagesMap` from
    // inside the updater so this effect only needs to depend on `sessions`
    // -- avoids refetching every flow whenever one entry is added.
    const sessionFlowNames = new Set<string>();
    for (const s of sessions || []) {
      const f = s.pipeline || s.flow;
      if (f) sessionFlowNames.add(f);
    }
    setFlowStagesMap((prev) => {
      for (const name of sessionFlowNames) {
        if (prev[name]) continue;
        // Kick off a fetch for each unknown flow; update map when it resolves.
        api
          .getFlowDetail(name)
          .then((d: any) => {
            if (d.stages?.length) {
              setFlowStagesMap((inner) => (inner[name] ? inner : { ...inner, [name]: d.stages }));
            }
          })
          .catch((err) => {
            console.warn(
              `SessionsPage: getFlowDetail failed (flow="${name}"; pipeline viz will render without stages):`,
              err instanceof Error ? err.message : err,
            );
          });
      }
      return prev;
    });
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
  }, [filteredSessions, selectedId, readOnly, showNew, setSelectedId]);

  async function handleNewSession(form: any) {
    // Control plane owns the atomic create+dispatch -- no post-create RPC here.
    const res = await api.createSession(form);
    if (res.ok) {
      const err = (res.session as any)?.error;
      if (err) {
        onToast(`Session ${res.session?.id || ""} created but dispatch failed: ${err}`, "error");
      } else {
        onToast(`Session ${res.session?.id || ""} started`, "success");
      }
      setShowNew(false);
      setSelectedId(res.session?.id || null);
      refresh();
    } else {
      onToast(`Failed to create session: ${res.message || "unknown error"}`, "error");
    }
  }

  const listPanel = !maximized ? (
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
      onArchive={async (id) => {
        try {
          const res = await api.archive(id);
          if (res.ok === false) {
            onToast?.(`Archive failed: ${res.message ?? "unknown error"}`, "error");
            return;
          }
          onToast?.(`Session ${id} archived`, "success");
          if (selectedId === id) setSelectedId(null);
          refresh();
        } catch (err: any) {
          onToast?.(`Archive failed: ${err?.message ?? err}`, "error");
        }
      }}
      onDelete={(id) => setPendingDeleteId(id)}
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
  ) : undefined;

  return (
    <Layout
      view={view}
      onNavigate={onNavigate}
      readOnly={readOnly}
      daemonStatus={daemonStatus}
      totalUnread={totalUnread}
      list={listPanel}
    >
      <h1 className="sr-only">Sessions</h1>

      {/* Center Panel */}
      {showNew ? (
        <div className="flex-1 overflow-y-auto bg-[var(--bg)]">
          <NewSessionModal onClose={() => setShowNew(false)} onSubmit={handleNewSession} />
        </div>
      ) : selectedId ? (
        <div className="detail-panel flex-1 flex flex-col min-w-0 overflow-hidden">
          <div className="shrink-0 px-4 pt-2 flex items-center justify-between">
            <button
              type="button"
              onClick={() => setSelectedId(null)}
              className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
            >
              <ArrowLeft size={12} />
              Back
            </button>
            <button
              type="button"
              onClick={() => setMaximized((prev) => !prev)}
              className="inline-flex items-center justify-center h-6 w-6 rounded text-[var(--fg-muted)] hover:text-[var(--fg)] hover:bg-[var(--bg-hover)] transition-colors cursor-pointer"
              title={maximized ? "Restore session list" : "Maximize session view"}
            >
              {maximized ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
            </button>
          </div>
          <SessionStreamErrorBoundary sessionId={selectedId}>
            <SessionDetail
              key={selectedId}
              sessionId={selectedId}
              onToast={onToast}
              readOnly={readOnly}
              initialTab={initialTab}
              onTabChange={onTabChange}
            />
          </SessionStreamErrorBoundary>
        </div>
      ) : (
        <DashboardView
          onNavigate={onNavigate}
          onSelectSession={(id) => {
            setSelectedId(id);
            setShowNew(false);
          }}
          readOnly={readOnly}
          daemonStatus={daemonStatus}
        />
      )}
      <ConfirmDialog
        open={pendingDeleteId !== null}
        onClose={() => !deletingBusy && setPendingDeleteId(null)}
        onConfirm={async () => {
          if (!pendingDeleteId) return;
          const id = pendingDeleteId;
          setDeletingBusy(true);
          try {
            const res = await api.deleteSession(id);
            if (res.ok === false) {
              onToast?.(`Delete failed: ${res.message ?? "unknown error"}`, "error");
              return;
            }
            onToast?.(`Session ${id} deleted`, "success");
            if (selectedId === id) setSelectedId(null);
            refresh();
          } catch (err: any) {
            onToast?.(`Delete failed: ${err?.message ?? err}`, "error");
          } finally {
            setDeletingBusy(false);
            setPendingDeleteId(null);
          }
        }}
        title="Delete session?"
        message={
          pendingDeleteId
            ? `This removes events, worktree, and tmux state for ${pendingDeleteId}. This cannot be undone.`
            : undefined
        }
        confirmLabel="Delete"
        danger
        loading={deletingBusy}
      />
    </Layout>
  );
}
