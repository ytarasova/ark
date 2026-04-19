import { useState, useEffect, useCallback } from "react";
import { api } from "../hooks/useApi.js";
import {
  useClaudeSessionsQuery,
  useRecentSessionsQuery,
  useRefreshHistoryMutation,
} from "../hooks/useHistoryQueries.js";
import { cn } from "../lib/utils.js";
import { relTime } from "../util.js";
import { Button } from "./ui/button.js";
import { Input } from "./ui/input.js";
import { Badge } from "./ui/badge.js";
import { StatusDot, StatusBadge } from "./StatusDot.js";
import { Search, Clock, FileText, Database, RefreshCw } from "lucide-react";

type SearchMode = "sessions" | "transcripts";

interface HistoryViewProps {
  onSelectSession?: (id: string) => void;
  mode?: SearchMode;
  onModeChange?: (mode: SearchMode) => void;
}

export function HistoryView({ onSelectSession, mode: controlledMode, onModeChange }: HistoryViewProps) {
  const [query, setQuery] = useState("");
  const [internalMode, setInternalMode] = useState<SearchMode>("sessions");
  const mode = controlledMode ?? internalMode;
  const _setMode = onModeChange ?? setInternalMode;
  const [sessionResults, setSessionResults] = useState<any[]>([]);
  const [transcriptResults, setTranscriptResults] = useState<any[]>([]);
  const [searched, setSearched] = useState(false);
  const [_loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<any>(null);
  const [selectedType, setSelectedType] = useState<"session" | "transcript">("session");

  // Recent Ark sessions -- TanStack Query handles mounted tracking + error
  // boundaries + re-fetch on focus. The hook file keeps the sort/slice logic.
  const recentSessionsQuery = useRecentSessionsQuery();
  const recentSessions = recentSessionsQuery.data ?? [];
  const loadingRecent = recentSessionsQuery.isPending;

  // Claude Code transcripts.
  const claudeSessionsQuery = useClaudeSessionsQuery();
  const claudeSessions = claudeSessionsQuery.data ?? [];
  const loadingClaude = claudeSessionsQuery.isPending;

  const refreshMutation = useRefreshHistoryMutation();
  const refreshing = refreshMutation.isPending;
  const handleRefresh = useCallback(() => refreshMutation.mutate(), [refreshMutation]);

  const doSearch = useCallback(async () => {
    if (!query.trim()) return;
    setLoading(true);
    try {
      if (mode === "sessions") {
        const data = await api.search(query);
        setSessionResults(data?.sessions || []);
        setTranscriptResults(data?.transcripts || []);
      } else {
        const data = await api.searchGlobal(query);
        setTranscriptResults(Array.isArray(data) ? data : data?.results || []);
        setSessionResults([]);
      }
      setSearched(true);
    } finally {
      setLoading(false);
    }
  }, [query, mode]);

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter") doSearch();
  }

  // Re-run the search when the user toggles between sessions / transcripts.
  // We keep both the previous mode and the latest doSearch in refs updated
  // inside a post-commit effect (no ref writes during render). The effect
  // below depends on `mode` only -- query + searched are read through the
  // ref so keystrokes don't fire network calls.
  const prevModeRef = useRef<SearchMode>(mode);
  const latestSearchRef = useRef<{ fn: () => Promise<void>; query: string; searched: boolean }>({
    fn: doSearch,
    query,
    searched,
  });
  useEffect(() => {
    latestSearchRef.current = { fn: doSearch, query, searched };
  });
  useEffect(() => {
    if (prevModeRef.current === mode) return;
    prevModeRef.current = mode;
    const { fn, query: q, searched: s } = latestSearchRef.current;
    if (s && q.trim()) fn();
  }, [mode]);

  function handleClear() {
    setQuery("");
    setSearched(false);
    setSessionResults([]);
    setTranscriptResults([]);
    setSelected(null);
  }

  // ---- Sessions tab content ----
  function renderSessionsTab() {
    // Build the list for the left panel
    const allResults = searched
      ? [
          ...sessionResults.map((r) => ({ ...r, _type: "session" as const })),
          ...transcriptResults.map((r) => ({ ...r, _type: "transcript" as const })),
        ]
      : recentSessions.map((s) => ({ ...s, _type: "recent" as const }));

    return (
      <>
        {/* Search bar */}
        <div className="px-3 py-2 border-b border-border/50">
          <div className="relative flex gap-1.5">
            <div className="relative flex-1">
              <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <Input
                className="w-full h-7 pl-7 pr-2 text-[12px] bg-secondary"
                placeholder="Search sessions..."
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={handleKeyDown}
              />
            </div>
          </div>
          {searched && (
            <div className="flex items-center justify-between mt-1">
              <span className="text-muted-foreground text-[10px] font-mono">
                {allResults.length} result{allResults.length !== 1 ? "s" : ""}
              </span>
              <button
                className="text-[10px] text-muted-foreground hover:text-foreground"
                onClick={handleClear}
                aria-label="Clear search results"
              >
                Clear
              </button>
            </div>
          )}
        </div>

        {/* Loading state */}
        {!searched && loadingRecent && (
          <div className="flex items-center justify-center py-12">
            <span className="text-[11px] text-muted-foreground">Loading...</span>
          </div>
        )}

        {/* Empty state */}
        {!searched && !loadingRecent && recentSessions.length === 0 && (
          <div className="flex flex-col items-center justify-center py-12 px-4">
            <Search size={20} className="text-muted-foreground/30 mb-2" />
            <p className="text-[11px] text-muted-foreground text-center">No sessions found</p>
          </div>
        )}

        {/* Not-searched: recent sessions list */}
        {!searched && !loadingRecent && recentSessions.length > 0 && (
          <>
            <div className="flex items-center gap-1.5 px-3 py-1.5 text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
              <Clock size={10} />
              Recent
            </div>
            {recentSessions.map((s: any) => (
              <div
                key={s.id}
                className={cn(
                  "flex flex-col px-4 py-2.5 cursor-pointer border-b border-border/50 transition-colors",
                  "hover:bg-accent",
                  selected?.id === s.id &&
                    selectedType === "session" &&
                    !searched &&
                    "bg-accent border-l-2 border-l-primary",
                )}
                onClick={() => {
                  setSelected(s);
                  setSelectedType("session");
                }}
              >
                <div className="flex items-center gap-2 min-w-0">
                  <StatusDot status={s.status} />
                  <span className="text-[12px] text-foreground truncate leading-snug">{s.summary || s.id}</span>
                </div>
                <div className="flex items-center gap-2 mt-1 text-[10px] text-muted-foreground font-mono">
                  <span>{s.id}</span>
                  <span className="flex-1" />
                  <span className="shrink-0">{relTime(s.updated_at)}</span>
                </div>
              </div>
            ))}
          </>
        )}

        {/* Searched: no results */}
        {searched && allResults.length === 0 && (
          <div className="flex flex-col items-center justify-center py-12 px-4">
            <Search size={20} className="text-muted-foreground/30 mb-2" />
            <p className="text-[11px] text-muted-foreground text-center">No results for "{query}"</p>
          </div>
        )}

        {/* Searched: session results */}
        {searched && sessionResults.length > 0 && (
          <>
            <div className="flex items-center gap-1.5 px-3 py-1.5 text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
              <Database size={10} />
              Sessions ({sessionResults.length})
            </div>
            {sessionResults.map((r: any, i: number) => (
              <div
                key={`s-${i}`}
                className={cn(
                  "flex flex-col px-4 py-2.5 cursor-pointer border-b border-border/50 transition-colors",
                  "hover:bg-accent",
                  selected === r && selectedType === "session" && "bg-accent border-l-2 border-l-primary",
                )}
                onClick={() => {
                  setSelected(r);
                  setSelectedType("session");
                }}
              >
                <div className="flex items-center gap-2 min-w-0">
                  <Badge variant="outline" className="text-[9px] shrink-0">
                    {r.source || "session"}
                  </Badge>
                  <span className="text-[12px] text-foreground truncate leading-snug">
                    {r.match ? String(r.match).slice(0, 50) : r.sessionId || ""}
                  </span>
                </div>
                <div className="flex items-center gap-2 mt-1 text-[10px] text-muted-foreground font-mono">
                  <span>{r.sessionId || ""}</span>
                  <span className="flex-1" />
                  {r.timestamp && <span className="shrink-0">{relTime(r.timestamp)}</span>}
                </div>
              </div>
            ))}
          </>
        )}

        {/* Searched: transcript results */}
        {searched && transcriptResults.length > 0 && (
          <>
            <div className="flex items-center gap-1.5 px-3 py-1.5 text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
              <FileText size={10} />
              Transcripts ({transcriptResults.length})
            </div>
            {transcriptResults.map((r: any, i: number) => (
              <div
                key={`t-${i}`}
                className={cn(
                  "flex flex-col px-4 py-2.5 cursor-pointer border-b border-border/50 transition-colors",
                  "hover:bg-accent",
                  selected === r && selectedType === "transcript" && "bg-accent border-l-2 border-l-primary",
                )}
                onClick={() => {
                  setSelected(r);
                  setSelectedType("transcript");
                }}
              >
                <span className="text-[12px] text-foreground truncate leading-snug">
                  {r.projectName || r.fileName || r.sessionId || `Transcript ${i + 1}`}
                </span>
                <span className="text-[10px] text-muted-foreground mt-1 truncate">
                  {(r.matchLine || r.match || r.content || "").slice(0, 60)}
                </span>
              </div>
            ))}
          </>
        )}
      </>
    );
  }

  // ---- Transcripts tab content ----
  function renderTranscriptsTab() {
    return (
      <>
        {/* Header with refresh button */}
        <div className="flex items-center justify-between px-3 py-2 border-b border-border/50">
          <div className="flex items-center gap-1.5 text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
            <FileText size={10} />
            Claude Code Sessions
          </div>
          <button
            className={cn(
              "flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors px-1.5 py-0.5 rounded",
              refreshing && "opacity-50 pointer-events-none",
            )}
            onClick={handleRefresh}
            disabled={refreshing}
            title="Refresh and re-index transcripts"
            aria-label="Refresh and re-index transcripts"
          >
            <RefreshCw size={10} className={cn(refreshing && "animate-spin")} />
            {refreshing ? "Refreshing..." : "Refresh"}
          </button>
        </div>

        {/* Loading state */}
        {loadingClaude && (
          <div className="flex items-center justify-center py-12">
            <span className="text-[11px] text-muted-foreground">Loading transcripts...</span>
          </div>
        )}

        {/* Empty state */}
        {!loadingClaude && claudeSessions.length === 0 && (
          <div className="flex flex-col items-center justify-center py-12 px-4">
            <FileText size={20} className="text-muted-foreground/30 mb-2" />
            <p className="text-[11px] text-muted-foreground text-center">No Claude Code transcripts found</p>
            <button
              className="text-[10px] text-primary hover:underline mt-2"
              onClick={handleRefresh}
              aria-label="Scan for transcripts"
            >
              Scan for transcripts
            </button>
          </div>
        )}

        {/* Claude sessions list */}
        {!loadingClaude &&
          claudeSessions.length > 0 &&
          claudeSessions.map((cs: any, i: number) => (
            <div
              key={cs.sessionId || i}
              className={cn(
                "flex flex-col px-4 py-2.5 cursor-pointer border-b border-border/50 transition-colors",
                "hover:bg-accent",
                selected?.sessionId === cs.sessionId &&
                  selectedType === "transcript" &&
                  "bg-accent border-l-2 border-l-primary",
              )}
              onClick={() => {
                setSelected(cs);
                setSelectedType("transcript");
              }}
            >
              <div className="flex items-center gap-2 min-w-0">
                <FileText size={10} className="text-muted-foreground shrink-0" />
                <span className="text-[12px] text-foreground truncate leading-snug">{cs.project || cs.sessionId}</span>
              </div>
              {cs.summary && (
                <span className="text-[11px] text-muted-foreground mt-0.5 truncate pl-[18px]">{cs.summary}</span>
              )}
              <div className="flex items-center gap-2 mt-1 text-[10px] text-muted-foreground font-mono pl-[18px]">
                {cs.messageCount != null && (
                  <span>
                    {cs.messageCount} msg{cs.messageCount !== 1 ? "s" : ""}
                  </span>
                )}
                <span className="flex-1" />
                <span className="shrink-0">{relTime(cs.lastActivity || cs.timestamp)}</span>
              </div>
            </div>
          ))}
      </>
    );
  }

  // ---- Detail panel for transcript (Claude session) ----
  function renderTranscriptDetail(cs: any) {
    return (
      <div className="p-5">
        <div className="flex items-center gap-2 mb-4">
          <Badge variant="outline" className="text-[10px]">
            transcript
          </Badge>
          {cs.project && <span className="text-[13px] font-semibold text-foreground">{cs.project}</span>}
        </div>
        {cs.summary && (
          <div className="mb-4">
            <h3 className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground mb-2">
              Summary
            </h3>
            <p className="text-[13px] text-foreground leading-relaxed">{cs.summary}</p>
          </div>
        )}
        <div className="mb-4">
          <h3 className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground mb-2">Details</h3>
          <div className="grid grid-cols-[120px_1fr] gap-y-1.5 gap-x-3 text-[13px]">
            <span className="text-muted-foreground">Session ID</span>
            <span className="text-card-foreground font-mono text-[12px] break-all">{cs.sessionId}</span>
            {cs.project && (
              <>
                <span className="text-muted-foreground">Project</span>
                <span className="text-card-foreground font-mono">{cs.project}</span>
              </>
            )}
            {cs.projectDir && (
              <>
                <span className="text-muted-foreground">Directory</span>
                <span className="text-card-foreground font-mono text-[12px] break-all">{cs.projectDir}</span>
              </>
            )}
            {cs.transcriptPath && (
              <>
                <span className="text-muted-foreground">Transcript</span>
                <span className="text-card-foreground font-mono text-[11px] break-all">{cs.transcriptPath}</span>
              </>
            )}
            {cs.messageCount != null && (
              <>
                <span className="text-muted-foreground">Messages</span>
                <span className="text-card-foreground">{cs.messageCount}</span>
              </>
            )}
            {(cs.lastActivity || cs.timestamp) && (
              <>
                <span className="text-muted-foreground">Last Activity</span>
                <span className="text-card-foreground font-mono">{relTime(cs.lastActivity || cs.timestamp)}</span>
              </>
            )}
            {cs.timestamp && (
              <>
                <span className="text-muted-foreground">Created</span>
                <span className="text-card-foreground font-mono">{relTime(cs.timestamp)}</span>
              </>
            )}
          </div>
        </div>
        {/* Conversation messages */}
        <TranscriptMessages sessionId={cs.sessionId || cs.session_id} />
      </div>
    );
  }

  // ---- Detail panel for search transcript result ----
  function renderSearchTranscriptDetail(r: any) {
    return (
      <div className="p-5">
        <div className="flex items-center gap-2 mb-4">
          <Badge variant="outline" className="text-[10px]">
            transcript
          </Badge>
          {r.projectName && <span className="text-[12px] text-muted-foreground font-mono">{r.projectName}</span>}
          {r.fileName && <span className="text-[12px] text-muted-foreground/60 font-mono">{r.fileName}</span>}
        </div>
        <div className="mb-4">
          <h3 className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground mb-2">Content</h3>
          <div className="bg-[var(--bg-code)] border border-border rounded-lg p-3.5 text-[13px] leading-[1.7] max-h-[400px] overflow-y-auto whitespace-pre-wrap break-words text-foreground">
            {r.matchLine || r.match || String(r.content || "")}
          </div>
        </div>
        {r.lineNumber && <div className="text-[10px] text-muted-foreground/50 font-mono">line {r.lineNumber}</div>}
        {onSelectSession && r.sessionId && (
          <Button size="sm" variant="outline" className="mt-3" onClick={() => onSelectSession(r.sessionId)}>
            View in Sessions
          </Button>
        )}
      </div>
    );
  }

  return (
    <div className="grid grid-cols-[260px_1fr] overflow-hidden h-full">
      {/* Left: list panel */}
      <div className="border-r border-border overflow-y-auto">
        {mode === "sessions" ? renderSessionsTab() : renderTranscriptsTab()}
      </div>

      {/* Right: detail panel */}
      <div className="overflow-y-auto bg-background">
        {/* Sessions tab: recent session detail */}
        {selected && selectedType === "session" && !searched && mode === "sessions" ? (
          <div className="p-5">
            <div className="flex items-center gap-2.5 mb-4">
              <StatusDot status={selected.status} />
              <h2 className="text-lg font-semibold text-foreground">{selected.summary || selected.id}</h2>
              <StatusBadge status={selected.status} />
            </div>
            <div className="mb-4">
              <h3 className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground mb-2">
                Details
              </h3>
              <div className="grid grid-cols-[120px_1fr] gap-y-1.5 gap-x-3 text-[13px]">
                <span className="text-muted-foreground">ID</span>
                <span className="text-card-foreground font-mono">{selected.id}</span>
                {selected.repo && (
                  <>
                    <span className="text-muted-foreground">Repository</span>
                    <span className="text-card-foreground font-mono">{selected.repo}</span>
                  </>
                )}
                {selected.agent && (
                  <>
                    <span className="text-muted-foreground">Agent</span>
                    <span className="text-card-foreground">{selected.agent}</span>
                  </>
                )}
                {selected.flow && (
                  <>
                    <span className="text-muted-foreground">Flow</span>
                    <span className="text-card-foreground">{selected.flow}</span>
                  </>
                )}
                {selected.updated_at && (
                  <>
                    <span className="text-muted-foreground">Updated</span>
                    <span className="text-card-foreground font-mono">{relTime(selected.updated_at)}</span>
                  </>
                )}
              </div>
            </div>
            {onSelectSession && (
              <Button size="sm" variant="outline" onClick={() => onSelectSession(selected.id)}>
                View in Sessions
              </Button>
            )}
          </div>
        ) : selected && selectedType === "session" && searched ? (
          /* Search session result detail */
          <div className="p-5">
            <div className="flex items-center gap-2 mb-4">
              <Badge variant="outline" className="text-[10px]">
                {selected.source || "session"}
              </Badge>
              <span className="text-[12px] text-muted-foreground font-mono">{selected.sessionId || ""}</span>
              {selected.timestamp && (
                <span className="text-[11px] text-muted-foreground/60 font-mono">{relTime(selected.timestamp)}</span>
              )}
            </div>
            {selected.match && (
              <div className="mb-4">
                <h3 className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground mb-2">
                  Match
                </h3>
                <div className="bg-[var(--bg-code)] border border-border rounded-lg p-3.5 text-[13px] leading-[1.7] max-h-[400px] overflow-y-auto whitespace-pre-wrap break-words text-foreground">
                  {String(selected.match)}
                </div>
              </div>
            )}
            {onSelectSession && selected.sessionId && (
              <Button size="sm" variant="outline" onClick={() => onSelectSession(selected.sessionId)}>
                View in Sessions
              </Button>
            )}
          </div>
        ) : selected && selectedType === "transcript" && searched ? (
          /* Search transcript result detail */
          renderSearchTranscriptDetail(selected)
        ) : selected && selectedType === "transcript" && mode === "transcripts" ? (
          /* Claude Code session detail (from Transcripts tab) */
          renderTranscriptDetail(selected)
        ) : (
          <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
            {mode === "transcripts" ? "Select a transcript" : searched ? "Select a result" : "Select a session"}
          </div>
        )}
      </div>
    </div>
  );
}

/** Loads and displays the last N conversation turns for a Claude session. */
function TranscriptMessages({ sessionId }: { sessionId: string }) {
  const [turns, setTurns] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [indexing, setIndexing] = useState(false);

  const loadMessages = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.getConversation(sessionId, 50);
      setTurns(Array.isArray(data) ? data : []);
    } catch {
      setTurns([]);
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    if (sessionId) loadMessages();
  }, [sessionId, loadMessages]);

  const handleIndex = async () => {
    setIndexing(true);
    try {
      await api.refreshHistory();
      await loadMessages();
    } catch {
      // ignore
    } finally {
      setIndexing(false);
    }
  };

  if (loading) {
    return <div className="text-[11px] text-muted-foreground py-4">Loading messages...</div>;
  }
  if (turns.length === 0) {
    return (
      <div className="text-[11px] text-muted-foreground py-4">
        No indexed messages yet.{" "}
        <button
          className={cn("text-primary hover:underline", indexing && "opacity-50 pointer-events-none")}
          onClick={handleIndex}
          disabled={indexing}
          aria-label="Index transcripts"
        >
          {indexing ? "Indexing..." : "Index transcripts"}
        </button>
      </div>
    );
  }

  return (
    <div className="mb-4">
      <h3 className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground mb-2">
        Recent Messages ({turns.length})
      </h3>
      <div className="flex flex-col gap-1.5">
        {turns.map((t: any, i: number) => (
          <div
            key={i}
            className={cn(
              "rounded-lg px-3 py-2 text-[12px] leading-relaxed max-w-[90%]",
              t.role === "user"
                ? "bg-primary/10 border border-primary/20 self-end text-foreground"
                : "bg-secondary border border-border self-start text-card-foreground",
            )}
          >
            <div className="flex items-center gap-2 mb-0.5">
              <span
                className={cn(
                  "text-[10px] font-semibold uppercase",
                  t.role === "user" ? "text-primary" : "text-muted-foreground",
                )}
              >
                {t.role}
              </span>
              {t.timestamp && <span className="text-[10px] text-muted-foreground">{relTime(t.timestamp)}</span>}
            </div>
            <div className="whitespace-pre-wrap break-words">
              {(t.content || "").slice(0, 500)}
              {(t.content || "").length > 500 ? "..." : ""}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
