interface SidebarProps {
  activeView: string;
  onNavigate: (view: string) => void;
  readOnly: boolean;
}

const NAV_ITEMS = [
  { id: "sessions", icon: "\u25B6", label: "Sessions" },
  { id: "costs", icon: "$", label: "Costs" },
  { id: "status", icon: "\u2261", label: "System Status" },
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
