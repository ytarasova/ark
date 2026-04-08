import { useState, useEffect, useCallback } from "react";
import { api } from "../hooks/useApi.js";
import { cn } from "../lib/utils.js";
import { relTime } from "../util.js";
import { Button } from "./ui/button.js";
import { Input } from "./ui/input.js";
import { Card } from "./ui/card.js";
import { Badge } from "./ui/badge.js";
import { StatusDot, StatusBadge } from "./StatusDot.js";
import { Search, Clock, FileText, Database } from "lucide-react";

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
  const setMode = onModeChange ?? setInternalMode;
  const [sessionResults, setSessionResults] = useState<any[]>([]);
  const [transcriptResults, setTranscriptResults] = useState<any[]>([]);
  const [recentSessions, setRecentSessions] = useState<any[]>([]);
  const [searched, setSearched] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingRecent, setLoadingRecent] = useState(true);

  // Load recent sessions on mount
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const sessions = await api.getSessions();
        if (!cancelled) {
          // Sort by updated_at descending, take 20
          const sorted = (sessions || [])
            .sort((a: any, b: any) => {
              const da = new Date(a.updated_at || 0).getTime();
              const db = new Date(b.updated_at || 0).getTime();
              return db - da;
            })
            .slice(0, 20);
          setRecentSessions(sorted);
        }
      } catch {
        // ignore - just show empty
      } finally {
        if (!cancelled) setLoadingRecent(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

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

  // Re-search when mode changes and there's an active query
  useEffect(() => {
    if (searched && query.trim()) {
      doSearch();
    }
  }, [mode]);

  function handleClear() {
    setQuery("");
    setSearched(false);
    setSessionResults([]);
    setTranscriptResults([]);
  }

  const hasResults = sessionResults.length > 0 || transcriptResults.length > 0;
  const totalResults = sessionResults.length + transcriptResults.length;

  return (
    <div>
      {/* Search bar */}
      <div className="flex gap-2 items-center mb-4 flex-wrap">
        <div className="relative flex-1 max-w-[480px]">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="w-full h-8 pl-9 pr-3 text-[13px] bg-secondary"
            placeholder={mode === "sessions" ? "Search sessions, events, messages..." : "Search Claude transcripts..."}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
          />
        </div>
        <Button
          size="sm"
          className={cn(loading && "opacity-60 cursor-wait")}
          onClick={doSearch}
          disabled={loading || !query.trim()}
        >
          {loading ? "Searching..." : "Search"}
        </Button>
        {searched && (
          <Button size="sm" variant="outline" onClick={handleClear}>
            Clear
          </Button>
        )}
      </div>

      {/* Default state: recent sessions */}
      {!searched && (
        <div>
          <div className="flex items-center gap-2 mb-3">
            <Clock size={14} className="text-muted-foreground" />
            <span className="text-sm font-medium text-muted-foreground">Recent Sessions</span>
          </div>

          {loadingRecent && (
            <div className="flex items-center justify-center py-12">
              <span className="text-sm text-muted-foreground">Loading...</span>
            </div>
          )}

          {!loadingRecent && recentSessions.length === 0 && (
            <div className="flex items-center justify-center h-[calc(100vh-260px)]">
              <div className="text-center">
                <Search size={28} className="text-muted-foreground/40 mx-auto mb-3" />
                <p className="text-sm text-muted-foreground">No sessions found. Use the search bar to find sessions and transcripts.</p>
              </div>
            </div>
          )}

          {!loadingRecent && recentSessions.length > 0 && (
            <div className="space-y-1.5">
              {recentSessions.map((s: any) => (
                <Card
                  key={s.id}
                  className={cn(
                    "p-3 transition-all duration-150",
                    onSelectSession && "cursor-pointer hover:bg-accent hover:border-ring"
                  )}
                  onClick={() => onSelectSession?.(s.id)}
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2.5 min-w-0">
                      <StatusDot status={s.status} />
                      <span className="text-[13px] font-semibold text-foreground truncate">
                        {s.summary || s.id}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      {s.repo && (
                        <span className="text-[10px] font-mono text-muted-foreground truncate max-w-[200px]">
                          {s.repo.split("/").pop()}
                        </span>
                      )}
                      <StatusBadge status={s.status} />
                    </div>
                  </div>
                  <div className="flex gap-3 mt-1.5 text-[11px] font-mono text-muted-foreground">
                    <span>{s.id}</span>
                    {s.agent && <span>{s.agent}</span>}
                    <span>{relTime(s.updated_at)}</span>
                  </div>
                </Card>
              ))}
            </div>
          )}
        </div>
      )}

      {/* No results */}
      {searched && !hasResults && (
        <div className="flex items-center justify-center h-[calc(100vh-260px)]">
          <div className="text-center">
            <Search size={28} className="text-muted-foreground/40 mx-auto mb-3" />
            <p className="text-sm text-muted-foreground">No results for "{query}"</p>
            <p className="text-xs text-muted-foreground/60 mt-1">
              {mode === "sessions"
                ? "Try searching transcripts for deeper results"
                : "Try searching sessions for metadata matches"}
            </p>
          </div>
        </div>
      )}

      {/* Search results */}
      {searched && hasResults && (
        <div className="flex flex-col gap-1.5">
          <div className="text-muted-foreground text-[11px] mb-2 font-mono">
            {totalResults} result{totalResults !== 1 ? "s" : ""}
          </div>

          {/* Session results */}
          {sessionResults.length > 0 && (
            <>
              <div className="text-xs font-medium text-muted-foreground mb-1 mt-2 flex items-center gap-1.5">
                <Database size={12} />
                Sessions ({sessionResults.length})
              </div>
              {sessionResults.map((r: any, i: number) => (
                <Card
                  key={`s-${i}`}
                  className={cn(
                    "p-3.5 transition-colors hover:bg-accent hover:border-ring",
                    onSelectSession && r.sessionId && "cursor-pointer"
                  )}
                  onClick={() => r.sessionId && onSelectSession?.(r.sessionId)}
                >
                  <div className="flex gap-2 items-center mb-1.5">
                    <Badge variant="outline" className="text-[10px]">{r.source || "session"}</Badge>
                    <span className="text-[10px] text-muted-foreground font-mono">{r.sessionId || ""}</span>
                    {r.timestamp && (
                      <span className="text-[10px] text-muted-foreground/60 font-mono">{relTime(r.timestamp)}</span>
                    )}
                  </div>
                  {r.match && (
                    <div className="text-xs text-muted-foreground leading-relaxed max-h-12 overflow-hidden text-ellipsis">
                      {String(r.match).slice(0, 300)}
                    </div>
                  )}
                </Card>
              ))}
            </>
          )}

          {/* Transcript results */}
          {transcriptResults.length > 0 && (
            <>
              <div className="text-xs font-medium text-muted-foreground mb-1 mt-3 flex items-center gap-1.5">
                <FileText size={12} />
                Transcripts ({transcriptResults.length})
              </div>
              {transcriptResults.map((r: any, i: number) => (
                <Card
                  key={`t-${i}`}
                  className="p-3.5 transition-colors hover:bg-accent hover:border-ring"
                >
                  <div className="flex gap-2 items-center mb-1.5">
                    <Badge variant="outline" className="text-[10px]">transcript</Badge>
                    {/* Global search results have projectName/fileName */}
                    {r.projectName && (
                      <span className="text-[10px] text-muted-foreground font-mono">{r.projectName}</span>
                    )}
                    {r.fileName && (
                      <span className="text-[10px] text-muted-foreground/60 font-mono">{r.fileName}</span>
                    )}
                    {/* Session search transcript results have sessionId */}
                    {r.sessionId && (
                      <span
                        className={cn(
                          "text-[10px] text-muted-foreground font-mono",
                          onSelectSession && "text-primary/80 cursor-pointer hover:text-primary"
                        )}
                        onClick={(e) => {
                          e.stopPropagation();
                          r.sessionId && onSelectSession?.(r.sessionId);
                        }}
                      >
                        {r.sessionId}
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-muted-foreground leading-relaxed max-h-12 overflow-hidden text-ellipsis">
                    {r.matchLine || r.match || String(r.content || "").slice(0, 300)}
                  </div>
                  {r.lineNumber && (
                    <div className="text-[10px] text-muted-foreground/50 font-mono mt-1">
                      line {r.lineNumber}
                    </div>
                  )}
                </Card>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}
