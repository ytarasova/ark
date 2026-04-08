import { useState } from "react";
import { Layout } from "../components/Layout.js";
import { ToolsView } from "../components/ToolsView.js";
import { cn } from "../lib/utils.js";
import { Sparkles, BookOpen } from "lucide-react";

const TAB_ICONS = { skills: Sparkles, recipes: BookOpen } as const;

interface ToolsPageProps {
  view: string;
  onNavigate: (view: string) => void;
  readOnly: boolean;
}

export function ToolsPage({ view, onNavigate, readOnly }: ToolsPageProps) {
  const [toolsTab, setToolsTab] = useState<"skills" | "recipes">("skills");

  return (
    <Layout
      view={view} onNavigate={onNavigate} readOnly={readOnly} title="Tools" padded={false}
      headerLeft={
        <div className="flex gap-1 ml-2">
          {(["skills", "recipes"] as const).map(t => {
            const Icon = TAB_ICONS[t];
            return (
              <button key={t} onClick={() => setToolsTab(t)} className={cn(
                "px-3 py-1 text-xs font-medium rounded-md transition-colors inline-flex items-center gap-1.5",
                toolsTab === t ? "bg-secondary text-foreground" : "text-muted-foreground hover:text-foreground"
              )}>
                <Icon size={12} />
                {t.charAt(0).toUpperCase() + t.slice(1)}
              </button>
            );
          })}
        </div>
      }
    >
      <ToolsView activeTab={toolsTab} onTabChange={setToolsTab} />
    </Layout>
  );
}
