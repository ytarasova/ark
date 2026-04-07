import { useState, useEffect } from "react";
import { api } from "../hooks/useApi.js";
import { cn } from "../lib/utils.js";
import { Card } from "./ui/card.js";
import { Badge } from "./ui/badge.js";
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
    <div className="flex flex-col h-full">
      {/* Tabs */}
      <div className="flex gap-0 border-b border-border shrink-0">
        <button
          className={cn(
            "px-4 py-2 text-sm font-medium border-b-2 transition-colors",
            tab === "skills" ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"
          )}
          onClick={() => handleTab("skills")}
        >
          Skills
        </button>
        <button
          className={cn(
            "px-4 py-2 text-sm font-medium border-b-2 transition-colors",
            tab === "recipes" ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"
          )}
          onClick={() => handleTab("recipes")}
        >
          Recipes
        </button>
      </div>

      {/* Split view - fills remaining space */}
      <div className="grid grid-cols-[260px_1fr] overflow-hidden flex-1 min-h-0">
        {/* Left: list panel */}
        <div className="bg-card border-r border-border overflow-y-auto">
          {items.length === 0 && (
            <div className="flex items-center justify-center h-full">
              <div className="text-center py-8">
                <Wrench size={24} className="text-muted-foreground/40 mx-auto mb-3" />
                <p className="text-sm text-muted-foreground">No {tab} found</p>
              </div>
            </div>
          )}
          {items.map((item: any) => (
            <div
              key={item.name}
              className={cn(
                "flex items-center justify-between px-4 py-2.5 cursor-pointer border-b border-border/50 transition-colors text-[13px]",
                "hover:bg-accent",
                selected?.name === item.name && "bg-accent border-l-2 border-l-primary font-semibold"
              )}
              onClick={() => handleSelect(item)}
            >
              <span className="text-foreground truncate">{item.name}</span>
              <Badge variant="secondary" className="text-[10px]">{item.source || "builtin"}</Badge>
            </div>
          ))}
        </div>
        {/* Right: detail panel */}
        <div className="p-5 overflow-y-auto bg-background">
          {selected ? (
            <>
              <h2 className="text-lg font-semibold text-foreground mb-1">{selected.name}</h2>
              {selected.description && (
                <p className="text-sm text-muted-foreground mb-5">{selected.description}</p>
              )}
              {tab === "skills" && (
                <div className="mb-4">
                  <h3 className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground mb-2">Content</h3>
                  <div className="bg-black/40 border border-border rounded-lg p-3.5 font-mono text-[11px] leading-[1.7] max-h-[300px] overflow-y-auto whitespace-pre-wrap break-all text-muted-foreground">{selected.content || selected.prompt || "(no content)"}</div>
                </div>
              )}
              {tab === "recipes" && (
                <>
                  <div className="mb-4">
                    <h3 className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground mb-2">Configuration</h3>
                    <div className="grid grid-cols-[120px_1fr] gap-y-1.5 gap-x-3 text-[13px]">
                      <span className="text-muted-foreground">Flow</span>
                      <span className="text-card-foreground font-mono">{selected.flow || "-"}</span>
                      <span className="text-muted-foreground">Agent</span>
                      <span className="text-card-foreground font-mono">{selected.agent || "-"}</span>
                      <span className="text-muted-foreground">Repo</span>
                      <span className="text-card-foreground font-mono">{selected.repo || "-"}</span>
                    </div>
                  </div>
                  {selected.variables && Object.keys(selected.variables).length > 0 && (
                    <div className="mb-4">
                      <h3 className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground mb-2">Variables</h3>
                      <div className="grid grid-cols-[120px_1fr] gap-y-1.5 gap-x-3 text-[13px]">
                        {Object.entries(selected.variables).map(([k, v]) => (
                          <div key={k} className="contents">
                            <span className="text-muted-foreground">{k}</span>
                            <span className="text-card-foreground font-mono">{String(v)}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  {selected.summary && (
                    <div className="mb-4">
                      <h3 className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground mb-2">Summary</h3>
                      <div className="bg-black/40 border border-border rounded-lg p-3.5 font-mono text-[11px] leading-[1.7] max-h-[300px] overflow-y-auto whitespace-pre-wrap break-all text-muted-foreground">{selected.summary}</div>
                    </div>
                  )}
                </>
              )}
            </>
          ) : (
            <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
              Select a {tab === "skills" ? "skill" : "recipe"}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
