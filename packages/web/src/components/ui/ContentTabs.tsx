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
  /** Accessible label for the tablist, announced by screen readers. */
  ariaLabel?: string;
}

/** DOM id for a tab button -- shared by tab + tabpanel for aria-labelledby wiring. */
export function tabButtonId(tabId: string): string {
  return `tab-${tabId}`;
}

/** DOM id for the panel a tab controls. */
export function tabPanelId(tabId: string): string {
  return `tabpanel-${tabId}`;
}

/**
 * Conversation / Terminal / Events / Diff / Todos tabs with count badges.
 * Keyboard shortcuts 1-5 handled by parent.
 *
 * Exposes full ARIA tablist semantics: the outer container is `role="tablist"`,
 * each button is `role="tab"` with a stable id, and `aria-controls` points at
 * the panel the parent renders. Pair with `<TabPanel>` for the content region.
 * See `.workflow/audit/8-a11y.md` finding B1.
 */
export function ContentTabs({
  tabs,
  activeTab,
  onTabChange,
  className,
  ariaLabel = "Content tabs",
  ...props
}: ContentTabsProps) {
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className={cn("flex border-b border-[var(--border)] px-5 shrink-0", className)}
      {...props}
    >
      {tabs.map((tab) => {
        const active = tab.id === activeTab;
        return (
          <button
            key={tab.id}
            id={tabButtonId(tab.id)}
            type="button"
            role="tab"
            aria-selected={active}
            aria-controls={tabPanelId(tab.id)}
            tabIndex={active ? 0 : -1}
            onClick={() => onTabChange(tab.id)}
            className={cn(
              "py-2.5 mr-6 text-[12px] font-medium cursor-pointer",
              "border-b-2 border-transparent flex items-center gap-1.5",
              "text-[var(--fg-muted)] hover:text-[var(--fg)] transition-colors duration-150",
              "bg-transparent",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)] focus-visible:ring-offset-0",
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

/**
 * Content region paired with a `ContentTabs` tab. Renders `role="tabpanel"`
 * with `aria-labelledby` pointing back at the tab button so screen readers
 * announce "<label> tab panel" when focus enters.
 */
export function TabPanel({ tabId, children, className, ...props }: React.ComponentProps<"div"> & { tabId: string }) {
  return (
    <div
      role="tabpanel"
      id={tabPanelId(tabId)}
      aria-labelledby={tabButtonId(tabId)}
      tabIndex={0}
      className={className}
      {...props}
    >
      {children}
    </div>
  );
}
