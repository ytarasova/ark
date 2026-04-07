import { useState } from "react";
import { api } from "../hooks/useApi.js";
import { cn } from "../lib/utils.js";
import { Button } from "./ui/button.js";
import { Input } from "./ui/input.js";
import { Card } from "./ui/card.js";
import { Badge } from "./ui/badge.js";
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
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="w-full h-8 pl-9 pr-3 text-[13px] bg-secondary"
            placeholder="Search sessions, events, transcripts..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
          />
        </div>
        <Button
          size="sm"
          className={cn(loading && "opacity-60 cursor-wait")}
          onClick={handleSearch}
          disabled={loading}
        >
          {loading ? "Searching..." : "Search"}
        </Button>
      </div>

      {/* Initial empty state */}
      {!searched && (
        <div className="flex items-center justify-center h-[calc(100vh-180px)]">
          <div className="text-center">
            <Search size={28} className="text-muted-foreground/40 mx-auto mb-3" />
            <p className="text-sm text-muted-foreground">Enter a search query to find sessions, events, and transcript content</p>
          </div>
        </div>
      )}

      {/* No results */}
      {searched && results.length === 0 && (
        <div className="flex items-center justify-center h-[calc(100vh-220px)]">
          <div className="text-center">
            <Search size={28} className="text-muted-foreground/40 mx-auto mb-3" />
            <p className="text-sm text-muted-foreground">No results for "{query}"</p>
          </div>
        </div>
      )}

      {/* Results */}
      {results.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <div className="text-muted-foreground text-[11px] mb-2 font-mono">
            {results.length} result{results.length !== 1 ? "s" : ""}
          </div>
          {results.map((r: any, i: number) => (
            <Card key={i} className="p-3.5 transition-colors hover:bg-accent hover:border-ring">
              <div className="flex gap-2 items-center mb-1.5">
                <Badge variant="default" className="text-[10px]">{r.type || "session"}</Badge>
                <span className="text-[10px] text-muted-foreground font-mono">{r.sessionId || r.id || ""}</span>
              </div>
              {r.summary && <div className="text-[13px] font-semibold text-foreground mb-1">{r.summary}</div>}
              {r.snippet && <div className="text-xs text-muted-foreground leading-relaxed max-h-12 overflow-hidden text-ellipsis">{r.snippet}</div>}
              {r.content && !r.snippet && (
                <div className="text-xs text-muted-foreground leading-relaxed max-h-12 overflow-hidden text-ellipsis">{String(r.content).slice(0, 200)}</div>
              )}
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
