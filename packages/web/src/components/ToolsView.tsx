import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useApi } from "../hooks/useApi.js";
import { useSkillsQuery } from "../hooks/useToolQueries.js";
import { cn } from "../lib/utils.js";
import { Badge } from "./ui/badge.js";
import { Button } from "./ui/button.js";
import { Wrench } from "lucide-react";

type Tab = "skills";

interface ToolsViewProps {
  activeTab?: Tab;
  onTabChange?: (tab: Tab) => void;
}

export function ToolsView({ activeTab: _activeTab = "skills", onTabChange: _onTabChange }: ToolsViewProps) {
  const api = useApi();
  const queryClient = useQueryClient();
  const { data: skills = [] } = useSkillsQuery();
  const [selected, setSelected] = useState<any>(null);

  return (
    <div className="grid grid-cols-[260px_1fr] overflow-hidden h-full">
      {/* Left: list panel */}
      <div className="border-r border-border overflow-y-auto">
        {skills.length === 0 && (
          <div className="flex items-center justify-center h-full">
            <div className="text-center py-8">
              <Wrench size={24} className="text-muted-foreground/40 mx-auto mb-3" />
              <p className="text-sm text-muted-foreground">No skills found</p>
            </div>
          </div>
        )}
        {skills.map((item: any) => (
          <div
            key={item.name}
            className={cn(
              "flex items-center justify-between px-4 py-2.5 cursor-pointer border-b border-border/50 transition-colors text-[13px]",
              "hover:bg-accent",
              selected?.name === item.name && "bg-accent border-l-2 border-l-primary font-semibold",
            )}
            onClick={() => setSelected(item)}
          >
            <span className="text-foreground truncate">{item.name}</span>
            <Badge variant="secondary" className="text-[10px]">
              {item.source || "builtin"}
            </Badge>
          </div>
        ))}
      </div>
      {/* Right: detail panel */}
      <div className="p-5 overflow-y-auto bg-background">
        {selected ? (
          <>
            <h2 className="text-lg font-semibold text-foreground mb-1">{selected.name}</h2>
            {selected.description && <p className="text-sm text-muted-foreground mb-5">{selected.description}</p>}
            <div className="mb-4">
              <h3 className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground mb-2">
                Content
              </h3>
              <div className="bg-[var(--bg-code)] border border-border rounded-lg p-3.5 font-mono text-[11px] leading-[1.7] max-h-[300px] overflow-y-auto whitespace-pre-wrap break-all text-muted-foreground">
                {selected.content || selected.prompt || "(no content)"}
              </div>
            </div>
            {selected.source !== "builtin" && (
              <div className="mt-4">
                <Button
                  variant="destructive"
                  size="xs"
                  onClick={async () => {
                    try {
                      await api.deleteSkill(selected.name);
                      setSelected(null);
                      queryClient.invalidateQueries({ queryKey: ["skills"] });
                    } catch {
                      /* delete may fail if resource is in use */
                    }
                  }}
                >
                  Delete
                </Button>
              </div>
            )}
          </>
        ) : (
          <div className="flex items-center justify-center h-full text-sm text-muted-foreground">Select a skill</div>
        )}
      </div>
    </div>
  );
}
