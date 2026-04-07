import { useState, useEffect, useCallback } from "react";
import { api } from "../hooks/useApi.js";
import { cn } from "../lib/utils.js";
import { Button } from "./ui/button.js";
import { Input } from "./ui/input.js";
import { Card } from "./ui/card.js";
import { Badge } from "./ui/badge.js";
import { BookOpen, Search } from "lucide-react";

export function MemoryView() {
  const [memories, setMemories] = useState<any[]>([]);
  const [search, setSearch] = useState("");
  const [searchResults, setSearchResults] = useState<any[] | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [newContent, setNewContent] = useState("");
  const [newTags, setNewTags] = useState("");
  const [newScope, setNewScope] = useState("global");
  const [loading, setLoading] = useState(false);

  const loadMemories = useCallback(async () => {
    const mems = await api.getMemories();
    setMemories(mems || []);
  }, []);

  useEffect(() => { loadMemories(); }, [loadMemories]);

  const handleSearch = async () => {
    if (!search.trim()) { setSearchResults(null); return; }
    setLoading(true);
    try {
      const results = await api.recallMemory(search.trim());
      setSearchResults(results || []);
    } finally {
      setLoading(false);
    }
  };

  const handleAdd = async () => {
    if (!newContent.trim()) return;
    await api.addMemory(newContent.trim(), {
      tags: newTags ? newTags.split(",").map(t => t.trim()).filter(Boolean) : undefined,
      scope: newScope || "global",
    });
    setNewContent("");
    setNewTags("");
    setShowAdd(false);
    loadMemories();
  };

  const handleForget = async (id: string) => {
    await api.forgetMemory(id);
    loadMemories();
    if (searchResults) setSearchResults(searchResults.filter(m => m.id !== id));
  };

  const displayList = searchResults ?? memories;

  return (
    <div>
      {/* Header with search and add */}
      <div className="flex gap-2 items-center mb-4 flex-wrap">
        <div className="relative flex-1 max-w-[480px]">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="w-full h-8 pl-9 pr-3 text-[13px] bg-secondary"
            placeholder="Search memories..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            onKeyDown={e => e.key === "Enter" && handleSearch()}
          />
        </div>
        <Button size="sm" className={cn(loading && "opacity-60 cursor-wait")} onClick={handleSearch} disabled={loading}>
          {loading ? "Searching..." : "Search"}
        </Button>
        {searchResults && (
          <Button variant="outline" size="sm" onClick={() => { setSearchResults(null); setSearch(""); }}>
            Clear
          </Button>
        )}
        <div className="flex-1" />
        <Button variant="success" size="sm" onClick={() => setShowAdd(!showAdd)}>
          {showAdd ? "Cancel" : "+ Add Memory"}
        </Button>
      </div>

      {/* Add form */}
      {showAdd && (
        <Card className="mb-4 p-4">
          <div className="mb-3.5">
            <label className="block text-[11px] font-semibold text-muted-foreground mb-1.5 uppercase tracking-[0.04em]">Content</label>
            <textarea
              className="w-full resize-y bg-transparent border border-input rounded-md px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              value={newContent}
              onChange={e => setNewContent(e.target.value)}
              placeholder="What should Ark remember?"
              rows={3}
            />
          </div>
          <div className="flex gap-2">
            <div className="flex-1 mb-3.5">
              <label className="block text-[11px] font-semibold text-muted-foreground mb-1.5 uppercase tracking-[0.04em]">Tags (comma-separated)</label>
              <Input
                value={newTags}
                onChange={e => setNewTags(e.target.value)}
                placeholder="e.g. aws, deploy, config"
              />
            </div>
            <div className="w-[120px] mb-3.5">
              <label className="block text-[11px] font-semibold text-muted-foreground mb-1.5 uppercase tracking-[0.04em]">Scope</label>
              <select
                className="w-full h-9 bg-transparent border border-input rounded-md px-3 py-1 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                value={newScope}
                onChange={e => setNewScope(e.target.value)}
              >
                <option value="global">global</option>
                <option value="project">project</option>
              </select>
            </div>
          </div>
          <div className="flex gap-2">
            <Button size="sm" onClick={handleAdd}>Save Memory</Button>
            <Button variant="outline" size="sm" onClick={() => setShowAdd(false)}>Cancel</Button>
          </div>
        </Card>
      )}

      {/* Result count */}
      {displayList.length > 0 && (
        <div className="text-muted-foreground text-[11px] mb-2 font-mono">
          {searchResults ? `${displayList.length} result${displayList.length !== 1 ? "s" : ""}` : `${memories.length} memor${memories.length !== 1 ? "ies" : "y"}`}
        </div>
      )}

      {/* Empty state */}
      {displayList.length === 0 && (
        <div className="flex items-center justify-center h-[calc(100vh-180px)]">
          <div className="text-center">
            <BookOpen size={28} className="text-muted-foreground/40 mx-auto mb-3" />
            <p className="text-sm text-muted-foreground">
              {searchResults ? `No memories matching "${search}"` : "No memories yet. Add one above."}
            </p>
          </div>
        </div>
      )}

      {/* Memory list */}
      {displayList.length > 0 && (
        <div className="flex flex-col gap-1.5">
          {displayList.map((m: any) => (
            <Card key={m.id} className="p-3.5 cursor-default">
              <div className="flex justify-between items-start gap-3">
                <div className="flex flex-col gap-1 min-w-0 flex-1">
                  <div className="text-xs text-foreground leading-relaxed">{m.content}</div>
                  <div className="flex gap-3 text-muted-foreground text-[11px] items-center flex-wrap">
                    <Badge variant="secondary" className="text-[10px]">{m.scope || "global"}</Badge>
                    {m.tags?.length > 0 && (
                      <span className="flex gap-1">
                        {m.tags.map((t: string) => (
                          <Badge key={t} variant="default" className="text-[11px]">{t}</Badge>
                        ))}
                      </span>
                    )}
                    {m.createdAt && <span className="font-mono">{m.createdAt.slice(0, 10)}</span>}
                    {m.created_at && !m.createdAt && <span className="font-mono">{m.created_at.slice(0, 10)}</span>}
                  </div>
                </div>
                <Button
                  variant="destructive"
                  size="xs"
                  onClick={() => handleForget(m.id)}
                >
                  Forget
                </Button>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
