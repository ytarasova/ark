import { useState } from "react";
import { api } from "../hooks/useApi.js";

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
      <div className="filter-bar" style={{ marginBottom: 16 }}>
        <input
          className="search-input"
          style={{ flex: 1, maxWidth: 480 }}
          placeholder="Search sessions, events, transcripts..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
        />
        <button className="btn btn-primary" onClick={handleSearch} disabled={loading}>
          {loading ? "Searching..." : "Search"}
        </button>
      </div>

      {!searched && (
        <div className="empty">
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.15, marginBottom: 16 }}>
            <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
          </svg>
          <div className="empty-text">Enter a search query to find sessions, events, and transcript content</div>
        </div>
      )}

      {searched && results.length === 0 && (
        <div className="empty">
          <div className="empty-text">No results for "{query}"</div>
        </div>
      )}

      {results.length > 0 && (
        <div className="search-results">
          <div style={{ color: "var(--label-quaternary)", fontSize: 11, marginBottom: 8, fontFamily: "var(--mono)" }}>
            {results.length} result{results.length !== 1 ? "s" : ""}
          </div>
          {results.map((r: any, i: number) => (
            <div key={i} className="search-result-card">
              <div className="search-result-header">
                <span className="search-result-type">{r.type || "session"}</span>
                <span className="search-result-id">{r.sessionId || r.id || ""}</span>
              </div>
              {r.summary && <div className="search-result-summary">{r.summary}</div>}
              {r.snippet && <div className="search-result-snippet">{r.snippet}</div>}
              {r.content && !r.snippet && (
                <div className="search-result-snippet">{String(r.content).slice(0, 200)}</div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
