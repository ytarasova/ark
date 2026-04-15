import { useState, useMemo, useEffect, useCallback, useRef } from "react";
import { Layout } from "../components/Layout.js";
import { SessionList } from "../components/SessionList.js";
import { SessionDetail } from "../components/SessionDetail.js";
import { NewSessionModal } from "../components/NewSessionModal.js";
import { useSessions } from "../hooks/useSessions.js";
import { api } from "../hooks/useApi.js";
import { Button } from "../components/ui/button.js";
import { Input } from "../components/ui/input.js";
import { Search } from "lucide-react";

const FILTERS = ["all", "running", "waiting", "pending", "stopped", "blocked", "completed", "failed", "archived"];

import type { DaemonStatus } from "../hooks/useDaemonStatus.js";

interface SessionsPageProps {
  view: string;
  onNavigate: (view: string) => void;
  readOnly: boolean;
  onToast: (msg: string, type: string) => void;
  daemonStatus?: DaemonStatus | null;
  initialSelectedId?: string | null;
  onSelectedChange?: (id: string | null) => void;
}

export function SessionsPage({
  view,
  onNavigate,
  readOnly,
  onToast,
  daemonStatus,
  initialSelectedId,
  onSelectedChange,
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
  // Pass "archived" to the server so it returns archived sessions (excluded by default)
  const serverStatus = filter === "archived" ? "archived" : undefined;
  const { sessions, groups: _groups, refresh } = useSessions(serverStatus);
  const [groupFilter, _setGroupFilter] = useState("");
  const [showNew, setShowNew] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  const runningCount = sessions.filter((s) => s.status === "running").length;
  const waitingCount = sessions.filter((s) => s.status === "waiting").length;
  const failedCount = sessions.filter((s) => s.status === "failed").length;

  // Compute filtered sessions for keyboard navigation (mirrors SessionList logic)
  // When filter is "archived", server already returns only archived sessions
  const filteredSessions = useMemo(() => {
    let list = sessions || [];
    if (filter !== "all" && filter !== "archived") list = list.filter((s) => s.status === filter);
    if (groupFilter) list = list.filter((s) => s.group_name === groupFilter);
    if (search) {
      const q = search.toLowerCase();
      list = list.filter(
        (s) =>
          (s.summary || "").toLowerCase().includes(q) ||
          (s.id || "").toLowerCase().includes(q) ||
          (s.repo || "").toLowerCase().includes(q) ||
          (s.agent || "").toLowerCase().includes(q),
      );
    }
    return list;
  }, [sessions, filter, search, groupFilter]);

  // Close chat when session changes
  useEffect(() => {
    setChatOpen(false);
  }, [selectedId]);

  // Keyboard shortcuts
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

      switch (e.key) {
        case "j": {
          // Next session
          e.preventDefault();
          if (filteredSessions.length === 0) break;
          const idx = selectedId ? filteredSessions.findIndex((s) => s.id === selectedId) : -1;
          const next = Math.min(idx + 1, filteredSessions.length - 1);
          setSelectedId(filteredSessions[next].id);
          setShowNew(false);
          break;
        }
        case "k": {
          // Previous session
          e.preventDefault();
          if (filteredSessions.length === 0) break;
          const idx = selectedId ? filteredSessions.findIndex((s) => s.id === selectedId) : filteredSessions.length;
          const prev = Math.max(idx - 1, 0);
          setSelectedId(filteredSessions[prev].id);
          setShowNew(false);
          break;
        }
        case "t": {
          // Toggle chat
          if (!selectedId) break;
          const sel = filteredSessions.find((s) => s.id === selectedId);
          if (sel && (sel.status === "running" || sel.status === "waiting")) {
            e.preventDefault();
            setChatOpen((o) => !o);
          }
          break;
        }
        case "n": {
          // New session
          if (readOnly) break;
          e.preventDefault();
          setShowNew(true);
          setSelectedId(null);
          break;
        }
        case "/": {
          // Focus search
          e.preventDefault();
          searchRef.current?.focus();
          break;
        }
        case "Escape": {
          if (chatOpen) {
            setChatOpen(false);
            break;
          }
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
    },
    [filteredSessions, selectedId, readOnly, chatOpen, showNew],
  );

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

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
      view={view}
      onNavigate={onNavigate}
      readOnly={readOnly}
      title="Sessions"
      daemonStatus={daemonStatus}
      padded={false}
      headerLeft={
        <div className="flex gap-1.5 items-center">
          {runningCount > 0 && (
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-emerald-500/15 text-emerald-400 border border-emerald-500/20">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
              {runningCount}
            </span>
          )}
          {waitingCount > 0 && (
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-amber-500/15 text-amber-400 border border-amber-500/20">
              <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />
              {waitingCount}
            </span>
          )}
          {failedCount > 0 && (
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-red-500/15 text-red-400 border border-red-500/20">
              <span className="w-1.5 h-1.5 rounded-full bg-red-400" />
              {failedCount}
            </span>
          )}
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
              ref={searchRef}
              className="w-40 h-7 pl-7 pr-2 text-[11px] bg-secondary"
              placeholder="Search (/)..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          {!readOnly && (
            <Button
              size="sm"
              onClick={() => {
                setShowNew(true);
                setSelectedId(null);
              }}
            >
              + New Session
            </Button>
          )}
        </div>
      }
    >
      <div className="grid grid-cols-[260px_1fr] overflow-hidden h-full">
        {/* Left: session list */}
        <div className="border-r border-border overflow-y-auto">
          <SessionList
            sessions={sessions}
            selectedId={selectedId}
            onSelect={(id) => {
              setSelectedId(id);
              setShowNew(false);
            }}
            filter={filter}
            search={search}
            groupFilter={groupFilter}
          />
        </div>
        {/* Right: detail panel or create form */}
        <div className="overflow-y-auto bg-background">
          {showNew ? (
            <NewSessionModal onClose={() => setShowNew(false)} onSubmit={handleNewSession} />
          ) : selectedId ? (
            <SessionDetail
              key={selectedId}
              sessionId={selectedId}
              onClose={() => setSelectedId(null)}
              onToast={onToast}
              readOnly={readOnly}
              chatOpen={chatOpen}
              onChatOpenChange={setChatOpen}
            />
          ) : (
            <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
              <div className="text-center">
                <div>Select a session or create a new one</div>
                <div className="mt-2 text-xs text-muted-foreground/60">
                  <kbd className="px-1.5 py-0.5 rounded bg-secondary text-[10px] font-mono">j</kbd>/
                  <kbd className="px-1.5 py-0.5 rounded bg-secondary text-[10px] font-mono">k</kbd> navigate{" "}
                  <kbd className="px-1.5 py-0.5 rounded bg-secondary text-[10px] font-mono">t</kbd> chat{" "}
                  <kbd className="px-1.5 py-0.5 rounded bg-secondary text-[10px] font-mono">n</kbd> new{" "}
                  <kbd className="px-1.5 py-0.5 rounded bg-secondary text-[10px] font-mono">/</kbd> search
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </Layout>
  );
}
