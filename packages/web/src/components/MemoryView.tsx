import { useState, useEffect, useCallback } from "react";
import { api } from "../hooks/useApi.js";
import { cn } from "../lib/utils.js";
import { BookOpen, Search } from "lucide-react";

const btnClass = "px-3 py-1 text-xs font-medium rounded-md border border-white/[0.06] text-white/50 hover:text-white/80 hover:border-white/[0.1] transition-colors";
const btnDanger = "px-3 py-1 text-xs font-medium rounded-md border border-red-500/20 text-red-400/70 hover:text-red-400 hover:border-red-500/30 transition-colors";
const btnPrimary = "px-3 py-1.5 text-xs font-medium rounded-md bg-indigo-500 border border-indigo-500/50 text-white hover:bg-indigo-400 transition-colors";
const btnSuccess = "px-3 py-1.5 text-xs font-medium rounded-md border border-emerald-500/20 text-emerald-400/70 hover:text-emerald-400 hover:border-emerald-500/30 transition-colors";
const inputClass = "bg-white/[0.03] border border-white/[0.06] rounded-lg px-3 py-2 text-[13px] text-white/90 placeholder:text-white/25 focus:border-indigo-500/50 focus:ring-1 focus:ring-indigo-500/20 outline-none transition-all";

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
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-white/25" />
          <input
            className="w-full h-8 pl-9 pr-3 text-[13px] bg-white/[0.03] border border-white/[0.06] rounded-lg text-white/90 placeholder:text-white/25 focus:border-indigo-500/50 focus:ring-1 focus:ring-indigo-500/20 outline-none transition-all"
            placeholder="Search memories..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            onKeyDown={e => e.key === "Enter" && handleSearch()}
          />
        </div>
        <button className={cn(btnPrimary, loading && "opacity-60 cursor-wait")} onClick={handleSearch} disabled={loading}>
          {loading ? "Searching..." : "Search"}
        </button>
        {searchResults && (
          <button className={btnClass} onClick={() => { setSearchResults(null); setSearch(""); }}>
            Clear
          </button>
        )}
        <div className="flex-1" />
        <button className={btnSuccess} onClick={() => setShowAdd(!showAdd)}>
          {showAdd ? "Cancel" : "+ Add Memory"}
        </button>
      </div>

      {/* Add form */}
      {showAdd && (
        <div className="mb-4 p-4 bg-white/[0.02] border border-white/[0.06] rounded-lg">
          <div className="mb-3.5">
            <label className="block text-[11px] font-semibold text-white/50 mb-1.5 uppercase tracking-[0.04em]">Content</label>
            <textarea
              className={cn(inputClass, "w-full resize-y")}
              value={newContent}
              onChange={e => setNewContent(e.target.value)}
              placeholder="What should Ark remember?"
              rows={3}
            />
          </div>
          <div className="flex gap-2">
            <div className="flex-1 mb-3.5">
              <label className="block text-[11px] font-semibold text-white/50 mb-1.5 uppercase tracking-[0.04em]">Tags (comma-separated)</label>
              <input
                className={cn(inputClass, "w-full")}
                value={newTags}
                onChange={e => setNewTags(e.target.value)}
                placeholder="e.g. aws, deploy, config"
              />
            </div>
            <div className="w-[120px] mb-3.5">
              <label className="block text-[11px] font-semibold text-white/50 mb-1.5 uppercase tracking-[0.04em]">Scope</label>
              <select
                className={cn(inputClass, "w-full")}
                value={newScope}
                onChange={e => setNewScope(e.target.value)}
              >
                <option value="global">global</option>
                <option value="project">project</option>
              </select>
            </div>
          </div>
          <div className="flex gap-2">
            <button className={btnPrimary} onClick={handleAdd}>Save Memory</button>
            <button className={btnClass} onClick={() => setShowAdd(false)}>Cancel</button>
          </div>
        </div>
      )}

      {/* Result count */}
      {displayList.length > 0 && (
        <div className="text-white/25 text-[11px] mb-2 font-mono">
          {searchResults ? `${displayList.length} result${displayList.length !== 1 ? "s" : ""}` : `${memories.length} memor${memories.length !== 1 ? "ies" : "y"}`}
        </div>
      )}

      {/* Empty state */}
      {displayList.length === 0 && (
        <div className="flex items-center justify-center h-[calc(100vh-180px)]">
          <div className="text-center">
            <BookOpen size={28} className="text-white/15 mx-auto mb-3" />
            <p className="text-sm text-white/35">
              {searchResults ? `No memories matching "${search}"` : "No memories yet. Add one above."}
            </p>
          </div>
        </div>
      )}

      {/* Memory list */}
      {displayList.length > 0 && (
        <div className="flex flex-col gap-1.5">
          {displayList.map((m: any) => (
            <div key={m.id} className="bg-white/[0.02] border border-white/[0.06] rounded-lg p-3.5 cursor-default">
              <div className="flex justify-between items-start gap-3">
                <div className="flex flex-col gap-1 min-w-0 flex-1">
                  <div className="text-xs text-white/80 leading-relaxed">{m.content}</div>
                  <div className="flex gap-3 text-white/35 text-[11px] items-center flex-wrap">
                    <span className="text-[10px] font-mono uppercase tracking-wider px-2 py-0.5 rounded bg-white/[0.04] border border-white/[0.06] text-white/25">{m.scope || "global"}</span>
                    {m.tags?.length > 0 && (
                      <span className="flex gap-1">
                        {m.tags.map((t: string) => (
                          <span key={t} className="inline-block px-2 py-0.5 rounded text-[11px] font-mono bg-indigo-500/10 border border-indigo-500/20 text-indigo-400">{t}</span>
                        ))}
                      </span>
                    )}
                    {m.createdAt && <span className="font-mono">{m.createdAt.slice(0, 10)}</span>}
                    {m.created_at && !m.createdAt && <span className="font-mono">{m.created_at.slice(0, 10)}</span>}
                  </div>
                </div>
                <button
                  className={btnDanger}
                  onClick={() => handleForget(m.id)}
                >
                  Forget
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
