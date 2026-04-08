import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import * as Dialog from "@radix-ui/react-dialog";
import { api } from "../hooks/useApi.js";
import { useMemoriesQuery } from "../hooks/useQueries.js";
import { cn } from "../lib/utils.js";
import { Button } from "./ui/button.js";
import { Input } from "./ui/input.js";
import { Card } from "./ui/card.js";
import { Badge } from "./ui/badge.js";
import { Separator } from "./ui/separator.js";
import { BookOpen, Search } from "lucide-react";

interface MemoryViewProps {
  showCreate?: boolean;
  onCloseCreate?: () => void;
}

export function MemoryView({ showCreate = false, onCloseCreate }: MemoryViewProps) {
  const queryClient = useQueryClient();
  const { data: memories = [] } = useMemoriesQuery();
  const [search, setSearch] = useState("");
  const [searchResults, setSearchResults] = useState<any[] | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [newContent, setNewContent] = useState("");
  const [newTags, setNewTags] = useState("");
  const [newScope, setNewScope] = useState("global");
  const [loading, setLoading] = useState(false);

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
    closeAddForm();
    queryClient.invalidateQueries({ queryKey: ["memories"] });
  };

  const handleForget = async (id: string) => {
    await api.forgetMemory(id);
    queryClient.invalidateQueries({ queryKey: ["memories"] });
    if (searchResults) setSearchResults(searchResults.filter(m => m.id !== id));
  };

  // External showCreate prop opens the add form
  const addFormVisible = showAdd || showCreate;

  function closeAddForm() {
    setShowAdd(false);
    onCloseCreate?.();
  }

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
      </div>

      {/* Add memory modal */}
      {addFormVisible && (
        <Dialog.Root open onOpenChange={(open) => { if (!open) closeAddForm(); }}>
          <Dialog.Portal>
            <Dialog.Overlay className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[200]" />
            <Dialog.Content className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[440px] max-w-[90vw] bg-card border border-border rounded-xl p-6 z-[200] shadow-2xl">
              <Dialog.Title className="text-base font-semibold text-foreground mb-5">
                Add Memory
              </Dialog.Title>
              <div className="mb-3.5">
                <label className="block text-[11px] font-semibold text-muted-foreground mb-1.5 uppercase tracking-[0.04em]">Content *</label>
                <textarea
                  autoFocus
                  className="w-full resize-y bg-transparent border border-input rounded-md px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  value={newContent}
                  onChange={e => setNewContent(e.target.value)}
                  placeholder="What should Ark remember?"
                  rows={3}
                />
              </div>
              <div className="mb-3.5">
                <label className="block text-[11px] font-semibold text-muted-foreground mb-1.5 uppercase tracking-[0.04em]">Tags (comma-separated)</label>
                <Input
                  value={newTags}
                  onChange={e => setNewTags(e.target.value)}
                  placeholder="e.g. aws, deploy, config"
                />
              </div>
              <div className="mb-3.5">
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
              <Separator className="mt-5" />
              <div className="flex justify-end gap-2 pt-4">
                <Button type="button" variant="outline" size="sm" onClick={closeAddForm}>Cancel</Button>
                <Button size="sm" onClick={handleAdd}>Save Memory</Button>
              </div>
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
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
