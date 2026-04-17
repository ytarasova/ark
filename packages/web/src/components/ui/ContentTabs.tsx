import { cn } from "../../lib/utils.js";
import { TabBadge } from "./TabBadge.js";

export interface TabDef {
  id: string;
  label: string;
  badge?: string | number;
}

export interface ContentTabsProps extends React.ComponentProps<"div"> {
  tabs: TabDef[];
  activeTab: string;
  onTabChange: (id: string) => void;
}

/**
 * Conversation / Terminal / Events / Diff / Todos tabs with count badges.
 * Keyboard shortcuts 1-5 handled by parent.
 */
export function ContentTabs({ tabs, activeTab, onTabChange, className, ...props }: ContentTabsProps) {
  return (
    <div className={cn("flex border-b border-[var(--border)] px-5 shrink-0", className)} {...props}>
      {tabs.map((tab, idx) => {
        const active = tab.id === activeTab;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onTabChange(tab.id)}
            className={cn(
              "py-2.5 mr-6 text-[12px] font-medium cursor-pointer",
              "border-b-2 border-transparent flex items-center gap-1.5",
              "text-[var(--fg-muted)] hover:text-[var(--fg)] transition-colors duration-150",
              "bg-transparent",
              active && "text-[var(--primary)] border-b-[var(--primary)]",
            )}
          >
            {tab.label}
            {tab.badge != null && <TabBadge active={active}>{tab.badge}</TabBadge>}
          </button>
        );
      })}
    </div>
  );
}
