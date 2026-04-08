import { useState, useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../hooks/useApi.js";
import { useMemoriesQuery } from "../hooks/useQueries.js";
import { cn } from "../lib/utils.js";
import { Button } from "./ui/button.js";
import { Input } from "./ui/input.js";
import { Badge } from "./ui/badge.js";
import { BookOpen, Search } from "lucide-react";

interface MemoryViewProps {
  addRequested?: number;
}

export function MemoryView({ addRequested = 0 }: MemoryViewProps) {
  const queryClient = useQueryClient();
  const { data: memories = [] } = useMemoriesQuery();
  const [search, setSearch] = useState("");
  const [searchResults, setSearchResults] = useState<any[] | null>(null);
  const [selected, setSelected] = useState<any>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [newContent, setNewContent] = useState("");
  const [newTags, setNewTags] = useState("");
  const [newScope, setNewScope] = useState("global");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (addRequested > 0) {
      setShowAdd(true);
      setSelected(null);
    }
  }, [addRequested]);

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
    queryClient.invalidateQueries({ queryKey: ["memories"] });
  };

  const handleForget = async (id: string) => {
    await api.forgetMemory(id);
    queryClient.invalidateQueries({ queryKey: ["memories"] });
    if (searchResults) setSearchResults(searchResults.filter(m => m.id !== id));
    if (selected?.id === id) setSelected(null);
  };

  const displayList = searchResults ?? memories;

  if (!displayList.length && !showAdd) {
    return (
      <div className="flex items-center justify-center h-[calc(100vh-180px)]">
        <div className="text-center">
          <BookOpen size={28} className="text-muted-foreground/30 mx-auto mb-3" />
          <p className="text-sm text-muted-foreground">
            {searchResults ? `No memories matching "${search}"` : "No memories yet"}
          </p>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="grid grid-cols-[260px_1fr] overflow-hidden h-full">
        {/* Left: list panel */}
        <div className="border-r border-border overflow-y-auto">
          {/* Search bar */}
          <div className="px-3 py-2 border-b border-border/50">
            <div className="relative flex gap-1.5">
              <div className="relative flex-1">
                <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
                <Input
                  className="w-full h-7 pl-7 pr-2 text-[12px] bg-secondary"
                  placeholder="Search..."
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  onKeyDown={e => e.key === "Enter" && handleSearch()}
                />
              </div>
              {searchResults && (
                <button
                  className="text-[10px] text-muted-foreground hover:text-foreground shrink-0"
                  onClick={() => { setSearchResults(null); setSearch(""); }}
                >
                  Clear
                </button>
              )}
            </div>
            {searchResults && (
              <div className="text-muted-foreground text-[10px] mt-1 font-mono">
                {displayList.length} result{displayList.length !== 1 ? "s" : ""}
              </div>
            )}
          </div>
          {/* Memory list */}
          {displayList.map((m: any) => (
            <div
              key={m.id}
              className={cn(
                "flex flex-col px-4 py-2.5 cursor-pointer border-b border-border/50 transition-colors text-[13px]",
                "hover:bg-accent",
                selected?.id === m.id && "bg-accent border-l-2 border-l-primary"
              )}
              onClick={() => { setSelected(m); setShowAdd(false); }}
            >
              <span className="text-foreground truncate text-[12px] leading-snug">
                {m.content?.length > 60 ? m.content.slice(0, 60) + "..." : m.content}
              </span>
              <div className="flex items-center gap-1.5 mt-1">
                {m.tags?.length > 0 && (
                  <span className="text-[10px] text-muted-foreground truncate">
                    {m.tags.slice(0, 3).join(", ")}
                  </span>
                )}
                <span className="flex-1" />
                <span className="text-[10px] text-muted-foreground/60 font-mono shrink-0">
                  {(m.createdAt || m.created_at || "").slice(0, 10)}
                </span>
              </div>
            </div>
          ))}
        </div>
        {/* Right: detail panel or add form */}
        <div className="overflow-y-auto bg-background">
          {showAdd ? (
            <div className="flex flex-col h-full p-5 overflow-y-auto">
              <h2 className="text-base font-semibold text-foreground mb-5">Add Memory</h2>
              <div className="mb-3.5">
                <label className="block text-[11px] font-semibold text-muted-foreground mb-1.5 uppercase tracking-[0.04em]">Content *</label>
                <textarea
                  autoFocus
                  className="w-full min-h-[120px] resize-none bg-transparent border border-input rounded-md px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  value={newContent}
                  onChange={e => setNewContent(e.target.value)}
                  placeholder="What should Ark remember?"
                />
              </div>
              <div className="grid grid-cols-2 gap-3 mb-3.5">
                <div>
                  <label className="block text-[11px] font-semibold text-muted-foreground mb-1.5 uppercase tracking-[0.04em]">Tags (comma-separated)</label>
                  <Input
                    value={newTags}
                    onChange={e => setNewTags(e.target.value)}
                    placeholder="e.g. aws, deploy, config"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-semibold text-muted-foreground mb-1.5 uppercase tracking-[0.04em]">Scope</label>
                  <select
                    className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm text-foreground shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring appearance-none pr-8 bg-[url('data:image/svg+xml;charset=UTF-8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2212%22%20height%3D%2212%22%20viewBox%3D%220%200%2024%2024%22%20fill%3D%22none%22%20stroke%3D%22%23888%22%20stroke-width%3D%222%22%3E%3Cpath%20d%3D%22m6%209%206%206%206-6%22%2F%3E%3C%2Fsvg%3E')] bg-no-repeat bg-[position:right_0.75rem_center]"
                    value={newScope}
                    onChange={e => setNewScope(e.target.value)}
                  >
                    <option value="global">global</option>
                    <option value="project">project</option>
                  </select>
                </div>
              </div>
              <div className="flex gap-2 pt-4 border-t border-border mt-auto">
                <Button variant="outline" size="sm" onClick={() => setShowAdd(false)}>Cancel</Button>
                <Button size="sm" onClick={handleAdd}>Save Memory</Button>
              </div>
            </div>
          ) : selected ? (
            <div className="p-5">
              <h2 className="text-lg font-semibold text-foreground mb-1">Memory</h2>
              <div className="mb-4">
                <h3 className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground mb-2">Content</h3>
                <div className="bg-black/40 border border-border rounded-lg p-3.5 text-[13px] leading-[1.7] max-h-[300px] overflow-y-auto whitespace-pre-wrap break-words text-foreground">
                  {selected.content}
                </div>
              </div>
              <div className="mb-4">
                <h3 className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground mb-2">Details</h3>
                <div className="grid grid-cols-[120px_1fr] gap-y-1.5 gap-x-3 text-[13px]">
                  <span className="text-muted-foreground">ID</span>
                  <span className="text-card-foreground font-mono">{selected.id}</span>
                  <span className="text-muted-foreground">Scope</span>
                  <span className="text-card-foreground">
                    <Badge variant="secondary" className="text-[10px]">{selected.scope || "global"}</Badge>
                  </span>
                  {selected.tags?.length > 0 && (
                    <>
                      <span className="text-muted-foreground">Tags</span>
                      <span className="flex gap-1 flex-wrap">
                        {selected.tags.map((t: string) => (
                          <Badge key={t} variant="default" className="text-[11px]">{t}</Badge>
                        ))}
                      </span>
                    </>
                  )}
                  {(selected.createdAt || selected.created_at) && (
                    <>
                      <span className="text-muted-foreground">Created</span>
                      <span className="text-card-foreground font-mono">
                        {(selected.createdAt || selected.created_at).slice(0, 10)}
                      </span>
                    </>
                  )}
                </div>
              </div>
              <div className="mt-5 flex gap-1.5">
                <Button variant="destructive" size="xs" onClick={() => handleForget(selected.id)}>
                  Forget
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
              Select a memory
            </div>
          )}
        </div>
      </div>
    </>
  );
}
