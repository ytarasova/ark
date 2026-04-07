import { useState, useEffect } from "react";
import { api } from "../hooks/useApi.js";
import { cn } from "../lib/utils.js";

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
      <div className="flex gap-0 mb-4 border-b border-white/8">
        <button
          className={cn(
            "px-4 py-2.5 text-[13px] font-medium cursor-pointer bg-transparent border-none border-b-2 border-b-transparent transition-all duration-200",
            tab === "skills" ? "text-label border-b-tint" : "text-label-tertiary hover:text-label"
          )}
          onClick={() => handleTab("skills")}
        >
          Skills
        </button>
        <button
          className={cn(
            "px-4 py-2.5 text-[13px] font-medium cursor-pointer bg-transparent border-none border-b-2 border-b-transparent transition-all duration-200",
            tab === "recipes" ? "text-label border-b-tint" : "text-label-tertiary hover:text-label"
          )}
          onClick={() => handleTab("recipes")}
        >
          Recipes
        </button>
      </div>
      <div className="grid grid-cols-[260px_1fr] rounded-xl glass-card glass-shine-subtle overflow-hidden h-[calc(100vh-112px)] max-md:grid-cols-1">
        <div className="glass-surface bg-glass-dark border-r border-white/8 overflow-y-auto h-full">
          {items.length === 0 && (
            <div className="text-center py-8 px-4 text-label-tertiary">
              <div className="text-[13px]">No {tab} found</div>
            </div>
          )}
          {items.map((item: any) => (
            <div
              key={item.name}
              className={cn(
                "flex justify-between items-center px-3.5 py-2.5 cursor-pointer border-b border-white/4 hover:bg-white/5 transition-colors text-xs",
                selected?.name === item.name && "bg-white/12 border-l-3 border-l-tint font-semibold shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]"
              )}
              onClick={() => handleSelect(item)}
            >
              <div className="font-medium text-[13px] text-label">{item.name}</div>
              <span className="text-[10px] font-medium uppercase tracking-[0.03em] px-2 py-0.5 rounded-full bg-white/6 text-label-tertiary whitespace-nowrap font-mono backdrop-blur-[4px]">{item.source || "builtin"}</span>
            </div>
          ))}
        </div>
        <div className="p-5 overflow-y-auto h-full bg-surface-0 bg-black/20 backdrop-blur-[20px] saturate-150">
          {selected ? (
            <>
              <h2 className="text-[15px] font-semibold text-label mb-1.5 tracking-[-0.01em]">{selected.name}</h2>
              {selected.description && (
                <p className="text-label-secondary text-[13px] mb-4 leading-relaxed">{selected.description}</p>
              )}
              {tab === "skills" && (
                <div className="mb-5">
                  <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-label-tertiary mb-2.5 pb-2 border-b border-white/8">Content</div>
                  <div className="bg-[rgba(8,8,12,0.8)] border border-white/8 rounded-lg p-3.5 font-mono text-[11px] leading-[1.7] max-h-[300px] overflow-y-auto whitespace-pre-wrap break-all text-label-secondary shadow-[inset_0_2px_4px_rgba(0,0,0,0.3)]">{selected.content || selected.prompt || "(no content)"}</div>
                </div>
              )}
              {tab === "recipes" && (
                <>
                  <div className="mb-5">
                    <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-label-tertiary mb-2.5 pb-2 border-b border-white/8">Configuration</div>
                    <div className="grid grid-cols-[100px_1fr] gap-x-3.5 gap-y-1.5 text-xs">
                      <div className="text-label-tertiary font-medium">Flow</div>
                      <div className="text-label">{selected.flow || "-"}</div>
                      <div className="text-label-tertiary font-medium">Agent</div>
                      <div className="text-label">{selected.agent || "-"}</div>
                      <div className="text-label-tertiary font-medium">Repo</div>
                      <div className="text-label">{selected.repo || "-"}</div>
                    </div>
                  </div>
                  {selected.variables && Object.keys(selected.variables).length > 0 && (
                    <div className="mb-5">
                      <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-label-tertiary mb-2.5 pb-2 border-b border-white/8">Variables</div>
                      <div className="grid grid-cols-[100px_1fr] gap-x-3.5 gap-y-1.5 text-xs">
                        {Object.entries(selected.variables).map(([k, v]) => (
                          <div key={k} className="contents">
                            <div className="text-label-tertiary font-medium">{k}</div>
                            <div className="text-label">{String(v)}</div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  {selected.summary && (
                    <div className="mb-5">
                      <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-label-tertiary mb-2.5 pb-2 border-b border-white/8">Summary</div>
                      <div className="bg-[rgba(8,8,12,0.8)] border border-white/8 rounded-lg p-3.5 font-mono text-[11px] leading-[1.7] max-h-[300px] overflow-y-auto whitespace-pre-wrap break-all text-label-secondary shadow-[inset_0_2px_4px_rgba(0,0,0,0.3)]">{selected.summary}</div>
                    </div>
                  )}
                </>
              )}
            </>
          ) : (
            <div className="text-center py-16 px-6 text-label-tertiary"><div className="text-[13px]">Select a {tab === "skills" ? "skill" : "recipe"}</div></div>
          )}
        </div>
      </div>
    </div>
  );
}
