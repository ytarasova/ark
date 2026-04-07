import { useState } from "react";
import { api } from "../hooks/useApi.js";
import { cn } from "../lib/utils.js";

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
      <div className="flex gap-2 items-center mb-4 flex-wrap">
        <input
          className="glass-input rounded-lg px-3.5 py-[7px] pl-8 text-[13px] flex-1 max-w-[480px] text-label placeholder:text-label-quaternary focus:border-tint focus:shadow-[0_0_0_3px_var(--color-tint-dim)] outline-none transition-all duration-200 bg-[length:13px] bg-[10px_center] bg-no-repeat"
          style={{ backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='14' height='14' viewBox='0 0 24 24' fill='none' stroke='rgba(255,255,255,0.3)' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Ccircle cx='11' cy='11' r='8'/%3E%3Cline x1='21' y1='21' x2='16.65' y2='16.65'/%3E%3C/svg%3E")` }}
          placeholder="Search sessions, events, transcripts..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
        />
        <button
          className={cn(
            "inline-flex items-center justify-center gap-1.5 px-3.5 py-[7px] rounded-lg text-[13px] font-semibold cursor-pointer bg-tint border-none text-white shadow-[0_2px_12px_rgba(124,106,239,0.3),inset_0_1px_0_rgba(255,255,255,0.15)] hover:brightness-110 active:scale-[0.97] transition-all duration-200",
            loading && "opacity-60 cursor-wait"
          )}
          onClick={handleSearch}
          disabled={loading}
        >
          {loading ? "Searching..." : "Search"}
        </button>
      </div>

      {!searched && (
        <div className="text-center py-16 px-6 text-label-tertiary">
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" className="opacity-15 mb-4 mx-auto">
            <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
          </svg>
          <div className="text-[13px]">Enter a search query to find sessions, events, and transcript content</div>
        </div>
      )}

      {searched && results.length === 0 && (
        <div className="text-center py-16 px-6 text-label-tertiary">
          <div className="text-[13px]">No results for "{query}"</div>
        </div>
      )}

      {results.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <div className="text-label-quaternary text-[11px] mb-2 font-mono">
            {results.length} result{results.length !== 1 ? "s" : ""}
          </div>
          {results.map((r: any, i: number) => (
            <div key={i} className="glass-card glass-shine-subtle rounded-xl p-3.5 transition-all duration-200 hover:bg-surface-1 hover:border-white/15">
              <div className="flex gap-2 items-center mb-1.5">
                <span className="text-[10px] font-medium uppercase tracking-[0.03em] px-2 py-0.5 rounded-full bg-tint-dim text-tint font-mono backdrop-blur-[4px]">{r.type || "session"}</span>
                <span className="text-[10px] text-label-quaternary font-mono">{r.sessionId || r.id || ""}</span>
              </div>
              {r.summary && <div className="text-[13px] font-semibold text-label mb-1">{r.summary}</div>}
              {r.snippet && <div className="text-xs text-label-secondary leading-relaxed max-h-12 overflow-hidden text-ellipsis">{r.snippet}</div>}
              {r.content && !r.snippet && (
                <div className="text-xs text-label-secondary leading-relaxed max-h-12 overflow-hidden text-ellipsis">{String(r.content).slice(0, 200)}</div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
