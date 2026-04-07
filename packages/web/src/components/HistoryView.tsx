import { useState } from "react";
import { api } from "../hooks/useApi.js";
import { cn } from "../lib/utils.js";
import { Search } from "lucide-react";

export function HistoryView() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<any[]>([]);
  const [searched, setSearched] = useState(false);
  const [loading, setLoading] = useState(false);

  async function handleSearch() {
    if (!query.trim()) return;
    setLoading(true);
    try {
      const data = await api.searchGlobal(query);
      setResults(data?.results || data || []);
      setSearched(true);
    } finally {
      setLoading(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter") handleSearch();
  }

  return (
    <div>
      {/* Search bar */}
      <div className="flex gap-2 items-center mb-4 flex-wrap">
        <div className="relative flex-1 max-w-[480px]">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-white/25" />
          <input
            className="w-full h-8 pl-9 pr-3 text-[13px] bg-white/[0.03] border border-white/[0.06] rounded-lg text-white/90 placeholder:text-white/25 focus:border-indigo-500/50 focus:ring-1 focus:ring-indigo-500/20 outline-none transition-all"
            placeholder="Search sessions, events, transcripts..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
          />
        </div>
        <button
          className={cn(
            "px-3.5 py-1.5 text-xs font-medium rounded-md bg-indigo-500 border border-indigo-500/50 text-white hover:bg-indigo-400 transition-colors",
            loading && "opacity-60 cursor-wait"
          )}
          onClick={handleSearch}
          disabled={loading}
        >
          {loading ? "Searching..." : "Search"}
        </button>
      </div>

      {/* Initial empty state */}
      {!searched && (
        <div className="flex items-center justify-center h-[calc(100vh-180px)]">
          <div className="text-center">
            <Search size={28} className="text-white/15 mx-auto mb-3" />
            <p className="text-sm text-white/35">Enter a search query to find sessions, events, and transcript content</p>
          </div>
        </div>
      )}

      {/* No results */}
      {searched && results.length === 0 && (
        <div className="flex items-center justify-center h-[calc(100vh-220px)]">
          <div className="text-center">
            <Search size={28} className="text-white/15 mx-auto mb-3" />
            <p className="text-sm text-white/35">No results for "{query}"</p>
          </div>
        </div>
      )}

      {/* Results */}
      {results.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <div className="text-white/25 text-[11px] mb-2 font-mono">
            {results.length} result{results.length !== 1 ? "s" : ""}
          </div>
          {results.map((r: any, i: number) => (
            <div key={i} className="bg-white/[0.02] border border-white/[0.06] rounded-lg p-3.5 transition-colors hover:bg-white/[0.04] hover:border-white/[0.1]">
              <div className="flex gap-2 items-center mb-1.5">
                <span className="text-[10px] font-medium uppercase tracking-wider px-2 py-0.5 rounded bg-indigo-500/10 text-indigo-400 border border-indigo-500/20 font-mono">{r.type || "session"}</span>
                <span className="text-[10px] text-white/25 font-mono">{r.sessionId || r.id || ""}</span>
              </div>
              {r.summary && <div className="text-[13px] font-semibold text-white/80 mb-1">{r.summary}</div>}
              {r.snippet && <div className="text-xs text-white/50 leading-relaxed max-h-12 overflow-hidden text-ellipsis">{r.snippet}</div>}
              {r.content && !r.snippet && (
                <div className="text-xs text-white/50 leading-relaxed max-h-12 overflow-hidden text-ellipsis">{String(r.content).slice(0, 200)}</div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
