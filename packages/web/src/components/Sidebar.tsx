interface SidebarProps {
  activeView: string;
  onNavigate: (view: string) => void;
  readOnly: boolean;
}

const NAV_ITEMS = [
  { id: "sessions", icon: "\u25B6", label: "Sessions" },
  { id: "agents", icon: "\u2699", label: "Agents" },
  { id: "tools", icon: "\u2692", label: "Tools" },
  { id: "flows", icon: "\u21C4", label: "Flows" },
  { id: "history", icon: "\u23F0", label: "History" },
  { id: "compute", icon: "\u2601", label: "Compute" },
  { id: "schedules", icon: "\u23F1", label: "Schedules" },
  { id: "memory", icon: "\u2691", label: "Memory" },
  { id: "costs", icon: "$", label: "Costs" },
  { id: "status", icon: "\u2261", label: "System" },
];

export function Sidebar({ activeView, onNavigate, readOnly }: SidebarProps) {
  return (
    <div className="sidebar">
      <div className="sidebar-header">
        <span className="sidebar-logo">Ark</span>
        <span className="sidebar-live" />
      </div>
      <nav className="sidebar-nav">
        {NAV_ITEMS.map((it) => (
          <div
            key={it.id}
            className={`nav-item${activeView === it.id ? " active" : ""}`}
            onClick={() => onNavigate(it.id)}
          >
            <span className="nav-icon">{it.icon}</span>
            <span className="sidebar-label">{it.label}</span>
          </div>
        ))}
      </nav>
      <div className="sidebar-footer">
        {readOnly ? "Read-only mode" : "Ark Dashboard"}
      </div>
    </div>
  );
}
