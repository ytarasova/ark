import { Search, Clock, FileText, Database, RefreshCw } from "lucide-react";
import { cn } from "../../lib/utils.js";
import { relTime } from "../../util.js";
import { Input } from "../ui/input.js";
import { Badge } from "../ui/badge.js";
import { StatusDot } from "../StatusDot.js";
import type { SearchMode } from "./useHistorySearch.js";

interface SessionsTabProps {
  query: string;
  setQuery: (q: string) => void;
  searched: boolean;
  sessionResults: any[];
  transcriptResults: any[];
  selected: any;
  selectedType: "session" | "transcript";
  setSelection: (value: any, type: "session" | "transcript") => void;
  handleKeyDown: (e: React.KeyboardEvent) => void;
  handleClear: () => void;
  recentSessions: any[];
  loadingRecent: boolean;
}

function SessionsTab({
  query,
  setQuery,
  searched,
  sessionResults,
  transcriptResults,
  selected,
  selectedType,
  setSelection,
  handleKeyDown,
  handleClear,
  recentSessions,
  loadingRecent,
}: SessionsTabProps) {
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
            <span className="text-muted-foreground text-[10px] tabular-nums font-[family-name:var(--font-mono-ui)]">
              {allResults.length} result{allResults.length !== 1 ? "s" : ""}
            </span>
            <button
              className="text-[10px] text-muted-foreground hover:text-foreground transition-colors duration-150 ease-[cubic-bezier(0.32,0.72,0,1)]"
              onClick={handleClear}
              aria-label="Clear search results"
            >
              Clear
            </button>
          </div>
        )}
      </div>

      {!searched && loadingRecent && (
        <div className="flex items-center justify-center py-12">
          <span className="text-[11px] text-muted-foreground">Loading...</span>
        </div>
      )}

      {!searched && !loadingRecent && recentSessions.length === 0 && (
        <div className="flex flex-col items-center justify-center py-12 px-4">
          <Search size={20} className="text-muted-foreground/30 mb-2" />
          <p className="text-[11px] text-muted-foreground text-center">No sessions found</p>
        </div>
      )}

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
                "flex flex-col px-4 py-2.5 cursor-pointer border-b border-border/50 transition-colors duration-150 ease-[cubic-bezier(0.32,0.72,0,1)]",
                "hover:bg-accent",
                selected?.id === s.id &&
                  selectedType === "session" &&
                  !searched &&
                  "bg-accent border-l-2 border-l-primary",
              )}
              onClick={() => setSelection(s, "session")}
            >
              <div className="flex items-center gap-2 min-w-0">
                <StatusDot status={s.status} />
                <span className="text-[12px] text-foreground truncate leading-snug">{s.summary || s.id}</span>
              </div>
              <div className="flex items-center gap-2 mt-1 text-[10px] text-muted-foreground tabular-nums font-[family-name:var(--font-mono-ui)]">
                <span>{s.id}</span>
                <span className="flex-1" />
                <span className="shrink-0">{relTime(s.updated_at)}</span>
              </div>
            </div>
          ))}
        </>
      )}

      {searched && allResults.length === 0 && (
        <div className="flex flex-col items-center justify-center py-12 px-4">
          <Search size={20} className="text-muted-foreground/30 mb-2" />
          <p className="text-[11px] text-muted-foreground text-center">No results for "{query}"</p>
        </div>
      )}

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
                "flex flex-col px-4 py-2.5 cursor-pointer border-b border-border/50 transition-colors duration-150 ease-[cubic-bezier(0.32,0.72,0,1)]",
                "hover:bg-accent",
                selected === r && selectedType === "session" && "bg-accent border-l-2 border-l-primary",
              )}
              onClick={() => setSelection(r, "session")}
            >
              <div className="flex items-center gap-2 min-w-0">
                <Badge variant="outline" className="text-[9px] shrink-0">
                  {r.source || "session"}
                </Badge>
                <span className="text-[12px] text-foreground truncate leading-snug">
                  {r.match ? String(r.match).slice(0, 50) : r.sessionId || ""}
                </span>
              </div>
              <div className="flex items-center gap-2 mt-1 text-[10px] text-muted-foreground tabular-nums font-[family-name:var(--font-mono-ui)]">
                <span>{r.sessionId || ""}</span>
                <span className="flex-1" />
                {r.timestamp && <span className="shrink-0">{relTime(r.timestamp)}</span>}
              </div>
            </div>
          ))}
        </>
      )}

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
                "flex flex-col px-4 py-2.5 cursor-pointer border-b border-border/50 transition-colors duration-150 ease-[cubic-bezier(0.32,0.72,0,1)]",
                "hover:bg-accent",
                selected === r && selectedType === "transcript" && "bg-accent border-l-2 border-l-primary",
              )}
              onClick={() => setSelection(r, "transcript")}
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

interface TranscriptsTabProps {
  claudeSessions: any[];
  loadingClaude: boolean;
  refreshing: boolean;
  handleRefresh: () => void;
  selected: any;
  selectedType: "session" | "transcript";
  setSelection: (value: any, type: "session" | "transcript") => void;
}

function TranscriptsTab({
  claudeSessions,
  loadingClaude,
  refreshing,
  handleRefresh,
  selected,
  selectedType,
  setSelection,
}: TranscriptsTabProps) {
  return (
    <>
      <div className="flex items-center justify-between px-3 py-2 border-b border-border/50">
        <div className="flex items-center gap-1.5 text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
          <FileText size={10} />
          Claude Code Sessions
        </div>
        <button
          className={cn(
            "flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors duration-150 ease-[cubic-bezier(0.32,0.72,0,1)] px-1.5 py-0.5 rounded-[6px]",
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

      {loadingClaude && (
        <div className="flex items-center justify-center py-12">
          <span className="text-[11px] text-muted-foreground">Loading transcripts...</span>
        </div>
      )}

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
            onClick={() => setSelection(cs, "transcript")}
          >
            <div className="flex items-center gap-2 min-w-0">
              <FileText size={10} className="text-muted-foreground shrink-0" />
              <span className="text-[12px] text-foreground truncate leading-snug">{cs.project || cs.sessionId}</span>
            </div>
            {cs.summary && (
              <span className="text-[11px] text-muted-foreground mt-0.5 truncate pl-[18px]">{cs.summary}</span>
            )}
            <div className="flex items-center gap-2 mt-1 text-[10px] text-muted-foreground tabular-nums font-[family-name:var(--font-mono-ui)] pl-[18px]">
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

export interface HistoryListProps {
  mode: SearchMode;
  query: string;
  setQuery: (q: string) => void;
  searched: boolean;
  sessionResults: any[];
  transcriptResults: any[];
  selected: any;
  selectedType: "session" | "transcript";
  setSelection: (value: any, type: "session" | "transcript") => void;
  handleKeyDown: (e: React.KeyboardEvent) => void;
  handleClear: () => void;
  recentSessions: any[];
  loadingRecent: boolean;
  claudeSessions: any[];
  loadingClaude: boolean;
  refreshing: boolean;
  handleRefresh: () => void;
}

export function HistoryList(props: HistoryListProps) {
  if (props.mode === "sessions") {
    return <SessionsTab {...props} />;
  }
  return <TranscriptsTab {...props} />;
}
