import { useState, useEffect } from "react";
import { api } from "../hooks/useApi.js";
import { cn } from "../lib/utils.js";
import { Wrench } from "lucide-react";

type Tab = "skills" | "recipes";

export function ToolsView() {
  const [tab, setTab] = useState<Tab>("skills");
  const [skills, setSkills] = useState<any[]>([]);
  const [recipes, setRecipes] = useState<any[]>([]);
  const [selected, setSelected] = useState<any>(null);

  useEffect(() => {
    api.getSkills().then((d) => setSkills(d || []));
    api.getRecipes().then((d) => setRecipes(d || []));
  }, []);

  const items = tab === "skills" ? skills : recipes;

  function handleSelect(item: any) {
    setSelected(item);
  }

  function handleTab(t: Tab) {
    setTab(t);
    setSelected(null);
  }

  return (
    <div>
      {/* Tabs */}
      <div className="flex gap-0 mb-4 border-b border-white/[0.06]">
        <button
          className={cn(
            "px-4 py-2 text-sm font-medium border-b-2 transition-colors",
            tab === "skills" ? "border-indigo-400 text-white/90" : "border-transparent text-white/40 hover:text-white/60"
          )}
          onClick={() => handleTab("skills")}
        >
          Skills
        </button>
        <button
          className={cn(
            "px-4 py-2 text-sm font-medium border-b-2 transition-colors",
            tab === "recipes" ? "border-indigo-400 text-white/90" : "border-transparent text-white/40 hover:text-white/60"
          )}
          onClick={() => handleTab("recipes")}
        >
          Recipes
        </button>
      </div>

      <div className="grid grid-cols-[260px_1fr] rounded-lg border border-white/[0.06] overflow-hidden h-[calc(100vh-160px)]">
        {/* Left: list panel */}
        <div className="bg-white/[0.02] border-r border-white/[0.06] overflow-y-auto">
          {items.length === 0 && (
            <div className="flex items-center justify-center h-full">
              <div className="text-center py-8">
                <Wrench size={24} className="text-white/15 mx-auto mb-3" />
                <p className="text-sm text-white/35">No {tab} found</p>
              </div>
            </div>
          )}
          {items.map((item: any) => (
            <div
              key={item.name}
              className={cn(
                "flex items-center justify-between px-4 py-2.5 cursor-pointer border-b border-white/[0.03] transition-colors text-[13px]",
                "hover:bg-white/[0.03]",
                selected?.name === item.name && "bg-white/[0.05] border-l-2 border-l-indigo-400 font-semibold"
              )}
              onClick={() => handleSelect(item)}
            >
              <span className="text-white/80 truncate">{item.name}</span>
              <span className="text-[10px] font-mono uppercase text-white/25 tracking-wider">{item.source || "builtin"}</span>
            </div>
          ))}
        </div>
        {/* Right: detail panel */}
        <div className="p-5 overflow-y-auto bg-[#0d0d11]">
          {selected ? (
            <>
              <h2 className="text-lg font-semibold text-white/90 mb-1">{selected.name}</h2>
              {selected.description && (
                <p className="text-sm text-white/40 mb-5">{selected.description}</p>
              )}
              {tab === "skills" && (
                <div className="mb-4">
                  <h3 className="text-[10px] font-semibold uppercase tracking-[0.08em] text-white/25 mb-2">Content</h3>
                  <div className="bg-black/40 border border-white/[0.06] rounded-lg p-3.5 font-mono text-[11px] leading-[1.7] max-h-[300px] overflow-y-auto whitespace-pre-wrap break-all text-white/50">{selected.content || selected.prompt || "(no content)"}</div>
                </div>
              )}
              {tab === "recipes" && (
                <>
                  <div className="mb-4">
                    <h3 className="text-[10px] font-semibold uppercase tracking-[0.08em] text-white/25 mb-2">Configuration</h3>
                    <div className="grid grid-cols-[120px_1fr] gap-y-1.5 gap-x-3 text-[13px]">
                      <span className="text-white/35">Flow</span>
                      <span className="text-white/75 font-mono">{selected.flow || "-"}</span>
                      <span className="text-white/35">Agent</span>
                      <span className="text-white/75 font-mono">{selected.agent || "-"}</span>
                      <span className="text-white/35">Repo</span>
                      <span className="text-white/75 font-mono">{selected.repo || "-"}</span>
                    </div>
                  </div>
                  {selected.variables && Object.keys(selected.variables).length > 0 && (
                    <div className="mb-4">
                      <h3 className="text-[10px] font-semibold uppercase tracking-[0.08em] text-white/25 mb-2">Variables</h3>
                      <div className="grid grid-cols-[120px_1fr] gap-y-1.5 gap-x-3 text-[13px]">
                        {Object.entries(selected.variables).map(([k, v]) => (
                          <div key={k} className="contents">
                            <span className="text-white/35">{k}</span>
                            <span className="text-white/75 font-mono">{String(v)}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  {selected.summary && (
                    <div className="mb-4">
                      <h3 className="text-[10px] font-semibold uppercase tracking-[0.08em] text-white/25 mb-2">Summary</h3>
                      <div className="bg-black/40 border border-white/[0.06] rounded-lg p-3.5 font-mono text-[11px] leading-[1.7] max-h-[300px] overflow-y-auto whitespace-pre-wrap break-all text-white/50">{selected.summary}</div>
                    </div>
                  )}
                </>
              )}
            </>
          ) : (
            <div className="flex items-center justify-center h-full text-sm text-white/25">
              Select a {tab === "skills" ? "skill" : "recipe"}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
