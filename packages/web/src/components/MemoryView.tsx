import { useState, useEffect, useCallback } from "react";
import { api } from "../hooks/useApi.js";
import { cn } from "../lib/utils.js";

const btnBase = "glass-btn inline-flex items-center justify-center gap-1.5 rounded-lg text-[13px] font-medium cursor-pointer text-label active:scale-[0.97] transition-all duration-200 whitespace-nowrap px-3.5 py-[7px]";
const btnPrimary = "bg-tint border-none text-white font-semibold shadow-[0_2px_12px_rgba(124,106,239,0.3),inset_0_1px_0_rgba(255,255,255,0.15)] hover:brightness-110";
const btnSuccess = "text-success border-success/20 bg-transparent hover:bg-success-dim hover:border-success/30";
const btnDanger = "text-danger border-danger/20 bg-transparent hover:bg-danger-dim hover:border-danger/30";
const btnSm = "px-2.5 py-1 text-xs";
const inputBase = "glass-input rounded-lg px-3 py-2 text-[13px] text-label placeholder:text-label-quaternary outline-none focus:border-tint focus:shadow-[0_0_0_3px_var(--color-tint-dim)] transition-all duration-200";

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
      {/* Header with count and add button */}
      <div className="flex gap-2 items-center mb-4 flex-wrap">
        <input
          className={cn(inputBase, "flex-1 max-w-[480px] pl-8 bg-[length:13px] bg-[10px_center] bg-no-repeat")}
          style={{ backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='14' height='14' viewBox='0 0 24 24' fill='none' stroke='rgba(255,255,255,0.3)' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Ccircle cx='11' cy='11' r='8'/%3E%3Cline x1='21' y1='21' x2='16.65' y2='16.65'/%3E%3C/svg%3E")` }}
          placeholder="Search memories..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          onKeyDown={e => e.key === "Enter" && handleSearch()}
        />
        <button className={cn(btnBase, btnPrimary, loading && "opacity-60 cursor-wait")} onClick={handleSearch} disabled={loading}>
          {loading ? "Searching..." : "Search"}
        </button>
        {searchResults && (
          <button className={btnBase} onClick={() => { setSearchResults(null); setSearch(""); }}>
            Clear
          </button>
        )}
        <div className="flex-1" />
        <button className={cn(btnBase, btnSuccess)} onClick={() => setShowAdd(!showAdd)}>
          {showAdd ? "Cancel" : "+ Add Memory"}
        </button>
      </div>

      {/* Add form */}
      {showAdd && (
        <div className="mb-4 p-4 glass-card glass-shine-subtle rounded-xl">
          <div className="mb-3.5">
            <label className="block text-[11px] font-semibold text-label-secondary mb-1.5 uppercase tracking-[0.04em]">Content</label>
            <textarea
              className={cn(inputBase, "w-full resize-y")}
              value={newContent}
              onChange={e => setNewContent(e.target.value)}
              placeholder="What should Ark remember?"
              rows={3}
            />
          </div>
          <div className="flex gap-2">
            <div className="flex-1 mb-3.5">
              <label className="block text-[11px] font-semibold text-label-secondary mb-1.5 uppercase tracking-[0.04em]">Tags (comma-separated)</label>
              <input
                className={cn(inputBase, "w-full")}
                value={newTags}
                onChange={e => setNewTags(e.target.value)}
                placeholder="e.g. aws, deploy, config"
              />
            </div>
            <div className="w-[120px] mb-3.5">
              <label className="block text-[11px] font-semibold text-label-secondary mb-1.5 uppercase tracking-[0.04em]">Scope</label>
              <select
                className={cn(inputBase, "w-full")}
                value={newScope}
                onChange={e => setNewScope(e.target.value)}
              >
                <option value="global">global</option>
                <option value="project">project</option>
              </select>
            </div>
          </div>
          <div className="flex gap-2">
            <button className={cn(btnBase, btnPrimary)} onClick={handleAdd}>Save Memory</button>
            <button className={btnBase} onClick={() => setShowAdd(false)}>Cancel</button>
          </div>
        </div>
      )}

      {/* Result count */}
      {displayList.length > 0 && (
        <div className="text-label-quaternary text-[11px] mb-2 font-mono">
          {searchResults ? `${displayList.length} result${displayList.length !== 1 ? "s" : ""}` : `${memories.length} memor${memories.length !== 1 ? "ies" : "y"}`}
        </div>
      )}

      {/* Empty state */}
      {displayList.length === 0 && (
        <div className="text-center py-16 px-6 text-label-tertiary">
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" className="opacity-15 mb-4 mx-auto">
            <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>
          </svg>
          <div className="text-[13px]">
            {searchResults ? `No memories matching "${search}"` : "No memories yet. Add one above."}
          </div>
        </div>
      )}

      {/* Memory list */}
      {displayList.length > 0 && (
        <div className="flex flex-col gap-1.5">
          {displayList.map((m: any) => (
            <div key={m.id} className="glass-card glass-shine-subtle rounded-xl p-3.5 cursor-default">
              <div className="flex justify-between items-start gap-3">
                <div className="flex flex-col gap-1 min-w-0 flex-1">
                  <div className="text-xs text-label leading-relaxed">{m.content}</div>
                  <div className="flex gap-3 text-label-tertiary text-[11px] items-center flex-wrap">
                    <span className="text-[10px] font-medium uppercase tracking-[0.03em] px-2 py-0.5 rounded-full bg-white/6 text-label-tertiary whitespace-nowrap font-mono backdrop-blur-[4px]">{m.scope || "global"}</span>
                    {m.tags?.length > 0 && (
                      <span className="flex gap-1">
                        {m.tags.map((t: string) => (
                          <span key={t} className="inline-block px-2 py-[3px] rounded-lg text-[11px] font-mono bg-tint-dim border border-tint/20 text-tint">{t}</span>
                        ))}
                      </span>
                    )}
                    {m.createdAt && <span className="font-mono">{m.createdAt.slice(0, 10)}</span>}
                    {m.created_at && !m.createdAt && <span className="font-mono">{m.created_at.slice(0, 10)}</span>}
                  </div>
                </div>
                <button
                  className={cn(btnBase, btnSm, btnDanger)}
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
