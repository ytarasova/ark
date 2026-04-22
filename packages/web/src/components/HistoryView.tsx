import { useCallback, useState } from "react";
import {
  useClaudeSessionsQuery,
  useRecentSessionsQuery,
  useRefreshHistoryMutation,
} from "../hooks/useHistoryQueries.js";
import { HistoryList } from "./history/HistoryList.js";
import { RecentSessionDetail, SearchSessionDetail } from "./history/detail/SessionDetail.js";
import { ClaudeTranscriptDetail, SearchTranscriptDetail } from "./history/detail/TranscriptDetail.js";
import { useHistorySearch, type SearchMode } from "./history/useHistorySearch.js";

interface HistoryViewProps {
  onSelectSession?: (id: string) => void;
  mode?: SearchMode;
  onModeChange?: (mode: SearchMode) => void;
}

export function HistoryView({ onSelectSession, mode: controlledMode, onModeChange }: HistoryViewProps) {
  const [internalMode, setInternalMode] = useState<SearchMode>("sessions");
  const mode = controlledMode ?? internalMode;
  const _setMode = onModeChange ?? setInternalMode;

  const search = useHistorySearch(mode);

  const recentSessionsQuery = useRecentSessionsQuery();
  const recentSessions = recentSessionsQuery.data ?? [];
  const loadingRecent = recentSessionsQuery.isPending;

  const claudeSessionsQuery = useClaudeSessionsQuery();
  const claudeSessions = claudeSessionsQuery.data ?? [];
  const loadingClaude = claudeSessionsQuery.isPending;

  const refreshMutation = useRefreshHistoryMutation();
  const refreshing = refreshMutation.isPending;
  const handleRefresh = useCallback(() => refreshMutation.mutate(), [refreshMutation]);

  const { selected, selectedType, searched } = search;

  return (
    <div className="grid grid-cols-[260px_1fr] overflow-hidden h-full">
      <div className="border-r border-border overflow-y-auto">
        <HistoryList
          mode={mode}
          query={search.query}
          setQuery={search.setQuery}
          searched={searched}
          sessionResults={search.sessionResults}
          transcriptResults={search.transcriptResults}
          selected={selected}
          selectedType={selectedType}
          setSelection={search.setSelection}
          handleKeyDown={search.handleKeyDown}
          handleClear={search.handleClear}
          recentSessions={recentSessions}
          loadingRecent={loadingRecent}
          claudeSessions={claudeSessions}
          loadingClaude={loadingClaude}
          refreshing={refreshing}
          handleRefresh={handleRefresh}
        />
      </div>

      <div className="overflow-y-auto bg-background">
        {selected && selectedType === "session" && !searched && mode === "sessions" ? (
          <RecentSessionDetail selected={selected} onSelectSession={onSelectSession} />
        ) : selected && selectedType === "session" && searched ? (
          <SearchSessionDetail selected={selected} onSelectSession={onSelectSession} />
        ) : selected && selectedType === "transcript" && searched ? (
          <SearchTranscriptDetail r={selected} onSelectSession={onSelectSession} />
        ) : selected && selectedType === "transcript" && mode === "transcripts" ? (
          <ClaudeTranscriptDetail cs={selected} />
        ) : (
          <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
            {mode === "transcripts" ? "Select a transcript" : searched ? "Select a result" : "Select a session"}
          </div>
        )}
      </div>
    </div>
  );
}
