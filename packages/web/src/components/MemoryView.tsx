import React, { useState, useEffect } from "react";
import { useQueryClient, useQuery } from "@tanstack/react-query";
import { useApi } from "../hooks/useApi.js";
import { useMemoriesQuery } from "../hooks/useMemoryQueries.js";
import { cn } from "../lib/utils.js";
import { Button } from "./ui/button.js";
import { Input } from "./ui/input.js";
import { Badge } from "./ui/badge.js";
import { BookOpen, Search, BarChart3 } from "lucide-react";
import { RichSelect } from "./ui/RichSelect.js";

interface MemoryViewProps {
  addRequested?: number;
  onToast?: (msg: string, type: string) => void;
}

export function MemoryView({ addRequested = 0, onToast }: MemoryViewProps) {
  const api = useApi();
  const queryClient = useQueryClient();
  const { data: memories = [] } = useMemoriesQuery();
  const [search, setSearch] = useState("");
  const [searchResults, setSearchResults] = useState<any[] | null>(null);
  const [selected, setSelected] = useState<any>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [showStats, setShowStats] = useState(false);
  const [newContent, setNewContent] = useState("");
  const [newTags, setNewTags] = useState("");
  const [newScope, setNewScope] = useState("global");
  const [_loading, setLoading] = useState(false);

  // Knowledge stats query
  const { data: stats } = useQuery({
    queryKey: ["knowledge-stats"],
    queryFn: () => api.knowledgeStats(),
    enabled: showStats,
  });

  useEffect(() => {
    if (addRequested > 0) {
      setShowAdd(true);
      setShowStats(false);
      setSelected(null);
    }
  }, [addRequested]);

  const handleSearch = async () => {
    if (!search.trim()) {
      setSearchResults(null);
      return;
    }
    setLoading(true);
    try {
      const results = await api.knowledgeSearch(search.trim(), { types: ["memory", "learning"], limit: 20 });
      setSearchResults(results || []);
    } catch {
      // Fallback to old recall
      try {
        const results = await api.recallMemory(search.trim());
        setSearchResults(results || []);
      } catch {
        setSearchResults([]);
      }
    } finally {
      setLoading(false);
    }
  };

  const handleAdd = async () => {
    if (!newContent.trim()) return;
    await api.addMemory(newContent.trim(), {
      tags: newTags
        ? newTags
            .split(",")
            .map((t) => t.trim())
            .filter(Boolean)
        : undefined,
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
    if (searchResults) setSearchResults(searchResults.filter((m) => m.id !== id));
    if (selected?.id === id) setSelected(null);
  };

  const handleExport = async () => {
    try {
      await api.knowledgeExport();
      onToast?.("Knowledge exported to ./knowledge-export", "success");
    } catch (e: any) {
      onToast?.(`Export failed: ${e.message}`, "error");
    }
  };

  const handleImport = async () => {
    try {
      const result = await api.knowledgeImport();
      onToast?.(`Imported ${result?.imported ?? 0} nodes`, "success");
      queryClient.invalidateQueries({ queryKey: ["memories"] });
      queryClient.invalidateQueries({ queryKey: ["knowledge-stats"] });
    } catch (e: any) {
      onToast?.(`Import failed: ${e.message}`, "error");
    }
  };

  const getContent = (m: any) => m.content ?? m.label ?? "(no content)";

  const displayList = searchResults ?? memories;

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
                  placeholder="Search knowledge..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleSearch()}
                />
              </div>
              {searchResults && (
                <button
                  className="text-[10px] text-muted-foreground hover:text-foreground shrink-0"
                  onClick={() => {
                    setSearchResults(null);
                    setSearch("");
                  }}
                  aria-label="Clear search results"
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
          {/* Toolbar */}
          <div className="flex items-center gap-1.5 px-3 py-1.5 border-b border-border/30">
            <button
              className={cn(
                "text-[10px] px-2 py-0.5 rounded transition-colors",
                showStats ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:text-foreground",
              )}
              onClick={() => {
                setShowStats(!showStats);
                setShowAdd(false);
                setSelected(null);
              }}
              aria-label="Toggle knowledge stats"
            >
              <BarChart3 size={10} className="inline mr-0.5" /> Stats
            </button>
            <button
              className="text-[10px] px-2 py-0.5 rounded text-muted-foreground hover:text-foreground"
              onClick={handleExport}
              aria-label="Export knowledge"
            >
              Export
            </button>
            <button
              className="text-[10px] px-2 py-0.5 rounded text-muted-foreground hover:text-foreground"
              onClick={handleImport}
              aria-label="Import knowledge"
            >
              Import
            </button>
          </div>
          {/* Empty state in left panel */}
          {!displayList.length && !showAdd && !showStats && (
            <div className="flex flex-col items-center justify-center py-12 px-4">
              <BookOpen size={20} className="text-muted-foreground/30 mb-2" />
              <p className="text-[11px] text-muted-foreground text-center">
                {searchResults ? `No results matching "${search}"` : "No memories yet"}
              </p>
            </div>
          )}
          {/* Memory list */}
          {displayList.map((m: any) => (
            <div
              key={m.id}
              className={cn(
                "flex flex-col px-4 py-2.5 cursor-pointer border-b border-border/50 transition-colors text-[13px]",
                "hover:bg-accent",
                selected?.id === m.id && "bg-accent border-l-2 border-l-primary",
              )}
              onClick={() => {
                setSelected(m);
                setShowAdd(false);
                setShowStats(false);
              }}
            >
              <span className="text-foreground truncate text-[12px] leading-snug">
                {(() => {
                  const c = getContent(m);
                  return c.length > 60 ? c.slice(0, 60) + "..." : c;
                })()}
              </span>
              <div className="flex items-center gap-1.5 mt-1">
                {m.type && (
                  <Badge variant="secondary" className="text-[9px] px-1 py-0">
                    {m.type}
                  </Badge>
                )}
                {m.tags?.length > 0 && (
                  <span className="text-[10px] text-muted-foreground truncate">{m.tags.slice(0, 3).join(", ")}</span>
                )}
                {m.score !== undefined && (
                  <span className="text-[9px] text-muted-foreground/60 font-mono">{m.score.toFixed(2)}</span>
                )}
                <span className="flex-1" />
                <span className="text-[10px] text-muted-foreground/60 font-mono shrink-0">
                  {(m.createdAt || m.created_at || "").slice(0, 10)}
                </span>
              </div>
            </div>
          ))}
        </div>
        {/* Right: detail panel, add form, or stats */}
        <div className="overflow-y-auto bg-background">
          {showStats ? (
            <div className="p-5">
              <h2 className="text-base font-semibold text-foreground mb-4">Knowledge Graph Stats</h2>
              {stats ? (
                <div className="space-y-4">
                  <div className="grid grid-cols-2 gap-3">
                    <div className="bg-[var(--bg-code)] border border-border rounded-lg p-3.5">
                      <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-[0.04em]">
                        Total Nodes
                      </div>
                      <div className="text-2xl font-bold text-foreground mt-1">{stats.nodes ?? 0}</div>
                    </div>
                    <div className="bg-[var(--bg-code)] border border-border rounded-lg p-3.5">
                      <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-[0.04em]">
                        Total Edges
                      </div>
                      <div className="text-2xl font-bold text-foreground mt-1">{stats.edges ?? 0}</div>
                    </div>
                  </div>
                  {stats.by_node_type && Object.keys(stats.by_node_type).length > 0 && (
                    <div>
                      <h3 className="text-[10px] font-semibold text-muted-foreground mb-2 uppercase tracking-[0.08em]">
                        Nodes by Type
                      </h3>
                      <div className="grid grid-cols-[120px_1fr] gap-y-1 gap-x-3 text-[13px]">
                        {Object.entries(stats.by_node_type).map(([type, count]) => (
                          <React.Fragment key={type}>
                            <span className="text-muted-foreground">{type}</span>
                            <span className="text-foreground font-mono">{String(count)}</span>
                          </React.Fragment>
                        ))}
                      </div>
                    </div>
                  )}
                  {stats.by_edge_type && Object.keys(stats.by_edge_type).length > 0 && (
                    <div>
                      <h3 className="text-[10px] font-semibold text-muted-foreground mb-2 uppercase tracking-[0.08em]">
                        Edges by Relation
                      </h3>
                      <div className="grid grid-cols-[120px_1fr] gap-y-1 gap-x-3 text-[13px]">
                        {Object.entries(stats.by_edge_type).map(([rel, count]) => (
                          <React.Fragment key={rel}>
                            <span className="text-muted-foreground">{rel}</span>
                            <span className="text-foreground font-mono">{String(count)}</span>
                          </React.Fragment>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">Loading stats...</p>
              )}
            </div>
          ) : showAdd ? (
            <div className="flex flex-col h-full p-5 overflow-y-auto">
              <h2 className="text-base font-semibold text-foreground mb-5">Add Memory</h2>
              <div className="mb-3.5">
                <label className="block text-[11px] font-semibold text-muted-foreground mb-1.5 uppercase tracking-[0.04em]">
                  Content *
                </label>
                <textarea
                  autoFocus
                  className="w-full min-h-[120px] resize-none bg-transparent border border-input rounded-md px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  value={newContent}
                  onChange={(e) => setNewContent(e.target.value)}
                  placeholder="What should Ark remember?"
                />
              </div>
              <div className="grid grid-cols-2 gap-3 mb-3.5">
                <div>
                  <label className="block text-[11px] font-semibold text-muted-foreground mb-1.5 uppercase tracking-[0.04em]">
                    Tags (comma-separated)
                  </label>
                  <Input
                    value={newTags}
                    onChange={(e) => setNewTags(e.target.value)}
                    placeholder="e.g. aws, deploy, config"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-semibold text-muted-foreground mb-1.5 uppercase tracking-[0.04em]">
                    Scope
                  </label>
                  <RichSelect
                    value={newScope}
                    onChange={setNewScope}
                    options={[
                      { value: "global", label: "global", description: "Available across all projects" },
                      { value: "project", label: "project", description: "Available only in this project" },
                    ]}
                  />
                </div>
              </div>
              <div className="flex gap-2 pt-4 border-t border-border mt-auto">
                <Button variant="outline" size="sm" onClick={() => setShowAdd(false)}>
                  Cancel
                </Button>
                <Button size="sm" onClick={handleAdd}>
                  Save Memory
                </Button>
              </div>
            </div>
          ) : selected ? (
            <div className="p-5">
              <h2 className="text-lg font-semibold text-foreground mb-1">
                {selected.type ? `${selected.type.charAt(0).toUpperCase() + selected.type.slice(1)}` : "Memory"}
              </h2>
              <div className="mb-4">
                <h3 className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground mb-2">
                  Content
                </h3>
                <div className="bg-[var(--bg-code)] border border-border rounded-lg p-3.5 text-[13px] leading-[1.7] max-h-[300px] overflow-y-auto whitespace-pre-wrap break-words text-foreground">
                  {getContent(selected)}
                </div>
              </div>
              <div className="mb-4">
                <h3 className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground mb-2">
                  Details
                </h3>
                <div className="grid grid-cols-[120px_1fr] gap-y-1.5 gap-x-3 text-[13px]">
                  <span className="text-muted-foreground">ID</span>
                  <span className="text-card-foreground font-mono">{selected.id}</span>
                  {selected.type && (
                    <>
                      <span className="text-muted-foreground">Type</span>
                      <span className="text-card-foreground">
                        <Badge variant="secondary" className="text-[10px]">
                          {selected.type}
                        </Badge>
                      </span>
                    </>
                  )}
                  <span className="text-muted-foreground">Scope</span>
                  <span className="text-card-foreground">
                    <Badge variant="secondary" className="text-[10px]">
                      {selected.scope || selected.metadata?.scope || "global"}
                    </Badge>
                  </span>
                  {(selected.tags?.length > 0 || (selected.metadata?.tags as any)?.length > 0) && (
                    <>
                      <span className="text-muted-foreground">Tags</span>
                      <span className="flex gap-1 flex-wrap">
                        {(selected.tags ?? selected.metadata?.tags ?? []).map((t: string) => (
                          <Badge key={t} variant="default" className="text-[11px]">
                            {t}
                          </Badge>
                        ))}
                      </span>
                    </>
                  )}
                  {selected.score !== undefined && (
                    <>
                      <span className="text-muted-foreground">Score</span>
                      <span className="text-card-foreground font-mono">{selected.score.toFixed(2)}</span>
                    </>
                  )}
                  {selected.metadata?.recurrence !== undefined && (
                    <>
                      <span className="text-muted-foreground">Recurrence</span>
                      <span className="text-card-foreground font-mono">{String(selected.metadata.recurrence)}</span>
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
              Select a memory or learning
            </div>
          )}
        </div>
      </div>
    </>
  );
}
