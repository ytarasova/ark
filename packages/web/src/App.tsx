import "./styles.css";
import { useState, useCallback, useMemo } from "react";
import { createRoot } from "react-dom/client";
import { queryClient, QueryClientProvider } from "./providers/QueryProvider.js";
import { ThemeProvider, useTheme } from "./themes/ThemeProvider.js";
import { Toast } from "./components/Toast.js";
import { CommandPalette, type CommandItem } from "./components/ui/CommandPalette.js";
import { SessionsPage } from "./pages/SessionsPage.js";
import { ToolsPage } from "./pages/ToolsPage.js";
import { AgentsPage } from "./pages/AgentsPage.js";
import { FlowsPage } from "./pages/FlowsPage.js";
import { HistoryPage } from "./pages/HistoryPage.js";
import { ComputePage } from "./pages/ComputePage.js";
import { SchedulesPage } from "./pages/SchedulesPage.js";
import { MemoryPage } from "./pages/MemoryPage.js";
import { CostsPage } from "./pages/CostsPage.js";
import { SettingsPage } from "./pages/SettingsPage.js";
import { LoginPage } from "./pages/LoginPage.js";
import { DashboardPage } from "./pages/DashboardPage.js";
import { DesignPreviewPage } from "./pages/DesignPreviewPage.js";
import { useDaemonStatus } from "./hooks/useDaemonStatus.js";
import { useHashRouter } from "./hooks/useHashRouter.js";

const READ_ONLY = document.getElementById("root")?.dataset.readonly === "true";
const AUTH_REQUIRED = document.getElementById("root")?.dataset.auth === "true";

function App() {
  const { view, subId, navigate, setSubId } = useHashRouter();
  const [toast, setToast] = useState<{ msg: string; type: string } | null>(null);
  const [toastKey, setToastKey] = useState(0);
  const [cmdkOpen, setCmdkOpen] = useState(false);
  const [cmdkSearch, setCmdkSearch] = useState("");
  const [authenticated, setAuthenticated] = useState(() => {
    // If no auth required, or token exists in URL params or localStorage, skip login
    if (!AUTH_REQUIRED) return true;
    const urlToken = new URLSearchParams(window.location.search).get("token");
    if (urlToken) {
      localStorage.setItem("ark-token", urlToken);
      return true;
    }
    return !!localStorage.getItem("ark-token");
  });
  const readOnly = READ_ONLY;
  const daemonStatus = useDaemonStatus();

  function showToast(msg: string, type: string) {
    setToast({ msg, type });
    setToastKey((k) => k + 1);
  }

  // Navigate to a view (clears subId)
  const onNavigate = useCallback((v: string) => navigate(v), [navigate]);

  const { setThemeName, colorMode, toggleColorMode } = useTheme();

  const cmdkItems: CommandItem[] = useMemo(
    () => [
      {
        id: "nav-sessions",
        label: "Go to Sessions",
        section: "Navigation",
        shortcut: "",
        onSelect: () => onNavigate("sessions"),
      },
      { id: "nav-agents", label: "Go to Agents", section: "Navigation", onSelect: () => onNavigate("agents") },
      { id: "nav-flows", label: "Go to Flows", section: "Navigation", onSelect: () => onNavigate("flows") },
      { id: "nav-dashboard", label: "Go to Dashboard", section: "Navigation", onSelect: () => onNavigate("dashboard") },
      { id: "nav-history", label: "Go to History", section: "Navigation", onSelect: () => onNavigate("history") },
      { id: "nav-compute", label: "Go to Compute", section: "Navigation", onSelect: () => onNavigate("compute") },
      { id: "nav-schedules", label: "Go to Schedules", section: "Navigation", onSelect: () => onNavigate("schedules") },
      { id: "nav-memory", label: "Go to Memory", section: "Navigation", onSelect: () => onNavigate("memory") },
      { id: "nav-costs", label: "Go to Costs", section: "Navigation", onSelect: () => onNavigate("costs") },
      { id: "nav-settings", label: "Go to Settings", section: "Navigation", onSelect: () => onNavigate("settings") },
      {
        id: "theme-toggle-mode",
        label: `Switch to ${colorMode === "dark" ? "light" : "dark"} mode`,
        section: "Theme",
        onSelect: toggleColorMode,
      },
      {
        id: "theme-midnight",
        label: "Theme: Midnight Circuit",
        section: "Theme",
        onSelect: () => setThemeName("midnight-circuit"),
      },
      {
        id: "theme-arctic",
        label: "Theme: Arctic Slate",
        section: "Theme",
        onSelect: () => setThemeName("arctic-slate"),
      },
      {
        id: "theme-warm",
        label: "Theme: Warm Obsidian",
        section: "Theme",
        onSelect: () => setThemeName("warm-obsidian"),
      },
    ],
    [onNavigate, colorMode, toggleColorMode, setThemeName],
  );

  if (!authenticated) {
    return <LoginPage onLogin={() => setAuthenticated(true)} />;
  }

  return (
    <>
      {view === "_design" && <DesignPreviewPage />}
      {view === "dashboard" && (
        <DashboardPage view={view} onNavigate={onNavigate} readOnly={readOnly} daemonStatus={daemonStatus} />
      )}
      {view === "sessions" && (
        <SessionsPage
          view={view}
          onNavigate={onNavigate}
          readOnly={readOnly}
          onToast={showToast}
          daemonStatus={daemonStatus}
          initialSelectedId={subId}
          onSelectedChange={setSubId}
        />
      )}
      {view === "agents" && (
        <AgentsPage
          view={view}
          onNavigate={onNavigate}
          readOnly={readOnly}
          daemonStatus={daemonStatus}
          initialSelectedId={subId}
          onSelectedChange={setSubId}
        />
      )}
      {view === "tools" && (
        <ToolsPage view={view} onNavigate={onNavigate} readOnly={readOnly} daemonStatus={daemonStatus} />
      )}
      {view === "flows" && (
        <FlowsPage
          view={view}
          onNavigate={onNavigate}
          readOnly={readOnly}
          daemonStatus={daemonStatus}
          initialSelectedId={subId}
          onSelectedChange={setSubId}
        />
      )}
      {view === "history" && (
        <HistoryPage view={view} onNavigate={onNavigate} readOnly={readOnly} daemonStatus={daemonStatus} />
      )}
      {view === "compute" && (
        <ComputePage view={view} onNavigate={onNavigate} readOnly={readOnly} daemonStatus={daemonStatus} />
      )}
      {view === "schedules" && (
        <SchedulesPage view={view} onNavigate={onNavigate} readOnly={readOnly} daemonStatus={daemonStatus} />
      )}
      {view === "memory" && (
        <MemoryPage
          view={view}
          onNavigate={onNavigate}
          readOnly={readOnly}
          daemonStatus={daemonStatus}
          onToast={showToast}
        />
      )}
      {view === "costs" && (
        <CostsPage view={view} onNavigate={onNavigate} readOnly={readOnly} daemonStatus={daemonStatus} />
      )}
      {view === "settings" && (
        <SettingsPage view={view} onNavigate={onNavigate} readOnly={readOnly} daemonStatus={daemonStatus} />
      )}
      <CommandPalette
        open={cmdkOpen}
        onOpenChange={(v) => {
          setCmdkOpen(v);
          if (!v) setCmdkSearch("");
        }}
        items={cmdkItems}
        search={cmdkSearch}
        onSearchChange={setCmdkSearch}
      />
      {toast && <Toast key={toastKey} message={toast.msg} type={toast.type} onDone={() => setToast(null)} />}
    </>
  );
}

// ---- Mount ----
const root = createRoot(document.getElementById("root")!);
root.render(
  <QueryClientProvider client={queryClient}>
    <ThemeProvider defaultTheme="midnight-circuit">
      <App />
    </ThemeProvider>
  </QueryClientProvider>,
);
