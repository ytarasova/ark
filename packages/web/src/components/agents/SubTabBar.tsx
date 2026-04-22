import { cn } from "../../lib/utils.js";

export type AgentsSubTab = "roles" | "runtimes";

interface SubTabBarProps {
  active: AgentsSubTab;
  onChange: (tab: AgentsSubTab) => void;
}

export function SubTabBar({ active, onChange }: SubTabBarProps) {
  const tabs: { id: AgentsSubTab; label: string }[] = [
    { id: "roles", label: "Roles" },
    { id: "runtimes", label: "Runtimes" },
  ];

  return (
    <div className="flex border-b border-border px-4 shrink-0">
      {tabs.map((t) => (
        <button
          key={t.id}
          onClick={() => onChange(t.id)}
          className={cn(
            "px-3 py-2 text-[13px] font-medium transition-colors border-b-2 -mb-px",
            active === t.id
              ? "text-foreground border-primary"
              : "text-muted-foreground border-transparent hover:text-foreground hover:border-border",
          )}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}
