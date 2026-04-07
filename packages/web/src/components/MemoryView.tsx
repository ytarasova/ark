import { useState, useEffect, useCallback } from "react";
import { api } from "../hooks/useApi.js";

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
      <div className="filter-bar">
        <input
          className="search-input"
          style={{ flex: 1, maxWidth: 480 }}
          placeholder="Search memories..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          onKeyDown={e => e.key === "Enter" && handleSearch()}
        />
        <button className="btn btn-primary" onClick={handleSearch} disabled={loading}>
          {loading ? "Searching..." : "Search"}
        </button>
        {searchResults && (
          <button className="btn" onClick={() => { setSearchResults(null); setSearch(""); }}>
            Clear
          </button>
        )}
        <div style={{ flex: 1 }} />
        <button className="btn btn-success" onClick={() => setShowAdd(!showAdd)}>
          {showAdd ? "Cancel" : "+ Add Memory"}
        </button>
      </div>

      {/* Add form */}
      {showAdd && (
        <div style={{
          marginBottom: 16, padding: 16,
          background: "var(--surface-0)", backdropFilter: "blur(20px) saturate(150%)", border: "1px solid var(--glass-border)", borderRadius: 12, boxShadow: "inset 0 1px 0 rgba(255,255,255,0.04)",
        }}>
          <div className="form-group">
            <label className="form-label">Content</label>
            <textarea
              className="form-input"
              value={newContent}
              onChange={e => setNewContent(e.target.value)}
              placeholder="What should Ark remember?"
              rows={3}
              style={{ resize: "vertical" }}
            />
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <div className="form-group" style={{ flex: 1 }}>
              <label className="form-label">Tags (comma-separated)</label>
              <input
                className="form-input"
                value={newTags}
                onChange={e => setNewTags(e.target.value)}
                placeholder="e.g. aws, deploy, config"
              />
            </div>
            <div className="form-group" style={{ width: 120 }}>
              <label className="form-label">Scope</label>
              <select
                className="form-input"
                value={newScope}
                onChange={e => setNewScope(e.target.value)}
              >
                <option value="global">global</option>
                <option value="project">project</option>
              </select>
            </div>
          </div>
          <div className="form-actions" style={{ justifyContent: "flex-start" }}>
            <button className="btn btn-primary" onClick={handleAdd}>Save Memory</button>
            <button className="btn" onClick={() => setShowAdd(false)}>Cancel</button>
          </div>
        </div>
      )}

      {/* Result count */}
      {displayList.length > 0 && (
        <div style={{ color: "var(--label-quaternary)", fontSize: 11, marginBottom: 8, fontFamily: "var(--mono)" }}>
          {searchResults ? `${displayList.length} result${displayList.length !== 1 ? "s" : ""}` : `${memories.length} memor${memories.length !== 1 ? "ies" : "y"}`}
        </div>
      )}

      {/* Empty state */}
      {displayList.length === 0 && (
        <div className="empty">
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.15, marginBottom: 16 }}>
            <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>
          </svg>
          <div className="empty-text">
            {searchResults ? `No memories matching "${search}"` : "No memories yet. Add one above."}
          </div>
        </div>
      )}

      {/* Memory list */}
      {displayList.length > 0 && (
        <div className="session-list">
          {displayList.map((m: any) => (
            <div key={m.id} className="session-card" style={{ cursor: "default" }}>
              <div className="session-row">
                <div className="session-left" style={{ flexDirection: "column", alignItems: "flex-start", gap: 4 }}>
                  <div style={{ fontSize: 12, color: "var(--label)", lineHeight: 1.5 }}>{m.content}</div>
                  <div className="session-meta">
                    <span className="source-badge">{m.scope || "global"}</span>
                    {m.tags?.length > 0 && (
                      <span style={{ display: "flex", gap: 4 }}>
                        {m.tags.map((t: string) => (
                          <span key={t} className="tag tag-skill">{t}</span>
                        ))}
                      </span>
                    )}
                    {m.createdAt && <span>{m.createdAt.slice(0, 10)}</span>}
                    {m.created_at && !m.createdAt && <span>{m.created_at.slice(0, 10)}</span>}
                  </div>
                </div>
                <button
                  className="btn btn-danger btn-sm"
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
