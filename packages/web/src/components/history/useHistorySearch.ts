import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../hooks/useApi.js";

export type SearchMode = "sessions" | "transcripts";

export interface HistorySearchState {
  query: string;
  setQuery: (q: string) => void;
  searched: boolean;
  sessionResults: any[];
  transcriptResults: any[];
  selected: any;
  selectedType: "session" | "transcript";
  setSelection: (value: any, type: "session" | "transcript") => void;
  doSearch: () => Promise<void>;
  handleKeyDown: (e: React.KeyboardEvent) => void;
  handleClear: () => void;
}

/**
 * State machine for the History view's search UX:
 * - manages query text, searched flag, and two result buckets
 * - re-runs the search on mode flip (sessions <-> transcripts)
 * - exposes keyboard + clear handlers
 */
export function useHistorySearch(mode: SearchMode): HistorySearchState {
  const [query, setQuery] = useState("");
  const [sessionResults, setSessionResults] = useState<any[]>([]);
  const [transcriptResults, setTranscriptResults] = useState<any[]>([]);
  const [searched, setSearched] = useState(false);
  const [selected, setSelected] = useState<any>(null);
  const [selectedType, setSelectedType] = useState<"session" | "transcript">("session");

  const doSearch = useCallback(async () => {
    if (!query.trim()) return;
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
  }, [query, mode]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter") void doSearch();
    },
    [doSearch],
  );

  // Re-run the search when the user toggles between sessions / transcripts.
  // Post-commit refs keep the latest doSearch / query / searched without
  // re-triggering on keystrokes.
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
    if (s && q.trim()) void fn();
  }, [mode]);

  const handleClear = useCallback(() => {
    setQuery("");
    setSearched(false);
    setSessionResults([]);
    setTranscriptResults([]);
    setSelected(null);
  }, []);

  const setSelection = useCallback((value: any, type: "session" | "transcript") => {
    setSelected(value);
    setSelectedType(type);
  }, []);

  return {
    query,
    setQuery,
    searched,
    sessionResults,
    transcriptResults,
    selected,
    selectedType,
    setSelection,
    doSearch,
    handleKeyDown,
    handleClear,
  };
}
