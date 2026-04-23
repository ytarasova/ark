import { cn } from "../../lib/utils.js";
import { TabBadge } from "./TabBadge.js";

export interface TabDef {
  id: string;
  label: string;
  badge?: string | number;
  /** Render a small dot beside the tab label (indicates new / unread). */
  dot?: boolean;
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
 * Content tabs — rebuilt from `/tmp/ark-design-system/preview/app-chrome.html`
 * (`.tabs` + `.tabs span`).
 *
 *   tab strip    padding 0 18px; gap 2px; border-bottom 1 var(--border)
 *                height 36px (chrome-session-header variant)
 *   tab button   font sans 12px 500; padding 6px 10px (app-chrome)
 *                / 10px 14px (chrome-session-header). We keep 6px 10px.
 *                border-bottom 2px transparent, margin-bottom -1px.
 *   active       color fg, border var(--primary).
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
      className={cn("flex items-end gap-[2px] shrink-0", "px-[18px] border-b border-[var(--border)]", className)}
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
              "relative inline-flex items-center gap-[6px] px-[10px] py-[6px]",
              "font-[family-name:var(--font-sans)] text-[12px] font-medium",
              "bg-transparent border-0 cursor-pointer whitespace-nowrap",
              "text-[var(--fg-muted)] transition-colors duration-150",
              "hover:text-[var(--fg)]",
              "border-b-[2px] border-transparent -mb-px",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)] focus-visible:ring-offset-0",
              active && "text-[var(--fg)] !border-b-[var(--primary)]",
            )}
          >
            {tab.label}
            {tab.badge != null && <TabBadge active={active}>{tab.badge}</TabBadge>}
            {tab.dot && <span className="w-[5px] h-[5px] rounded-full bg-[var(--failed)]" />}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Content region paired with a `ContentTabs` tab.
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
