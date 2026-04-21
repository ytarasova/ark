import "./styles.css";
import { useState, useCallback, useMemo, lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { queryClient, QueryClientProvider } from "./providers/QueryProvider.js";
import { AppModeProvider } from "./providers/AppModeProvider.js";
import { ThemeProvider, useTheme } from "./themes/ThemeProvider.js";
import { TransportProvider } from "./transport/TransportContext.js";
import { HttpTransport } from "./transport/HttpTransport.js";
import { Toast } from "./components/Toast.js";
import { CommandPalette, type CommandItem } from "./components/ui/CommandPalette.js";
import { PageFallback } from "./components/ui/PageFallback.js";
import { RouteErrorBoundary } from "./components/ui/ErrorBoundary.js";
import { useDaemonStatus } from "./hooks/useDaemonStatus.js";
import { useHashRouter } from "./hooks/useHashRouter.js";

// Pages are lazy-loaded so each one ships as its own chunk. Heavy libraries
// (@xyflow/react via FlowsPage, recharts via CostsPage + ComputePage,
// @xterm/xterm via SessionsPage) ride along with their page chunk and stay
// out of the initial bundle.
const SessionsPage = lazy(() => import("./pages/SessionsPage.js").then((m) => ({ default: m.SessionsPage })));
const ToolsPage = lazy(() => import("./pages/ToolsPage.js").then((m) => ({ default: m.ToolsPage })));
const AgentsPage = lazy(() => import("./pages/AgentsPage.js").then((m) => ({ default: m.AgentsPage })));
const FlowsPage = lazy(() => import("./pages/FlowsPage.js").then((m) => ({ default: m.FlowsPage })));
const HistoryPage = lazy(() => import("./pages/HistoryPage.js").then((m) => ({ default: m.HistoryPage })));
const ComputePage = lazy(() => import("./pages/ComputePage.js").then((m) => ({ default: m.ComputePage })));
const SchedulesPage = lazy(() => import("./pages/SchedulesPage.js").then((m) => ({ default: m.SchedulesPage })));
const MemoryPage = lazy(() => import("./pages/MemoryPage.js").then((m) => ({ default: m.MemoryPage })));
const CostsPage = lazy(() => import("./pages/CostsPage.js").then((m) => ({ default: m.CostsPage })));
const IntegrationsPage = lazy(() =>
  import("./pages/IntegrationsPage.js").then((m) => ({ default: m.IntegrationsPage })),
);
const SettingsPage = lazy(() => import("./pages/SettingsPage.js").then((m) => ({ default: m.SettingsPage })));
const LoginPage = lazy(() => import("./pages/LoginPage.js").then((m) => ({ default: m.LoginPage })));
const DesignPreviewPage = lazy(() =>
  import("./pages/DesignPreviewPage.js").then((m) => ({ default: m.DesignPreviewPage })),
);

const READ_ONLY = document.getElementById("root")?.dataset.readonly === "true";
const AUTH_REQUIRED = document.getElementById("root")?.dataset.auth === "true";

function App() {
  const { view, subId, tab, navigate, setSubId, setTab } = useHashRouter();
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

  // Navigate to a view (clears subId and tab)
  const onNavigate = useCallback((v: string, id?: string | null, t?: string | null) => navigate(v, id, t), [navigate]);

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
    return (
      <Suspense fallback={<PageFallback />}>
        <LoginPage onLogin={() => setAuthenticated(true)} />
      </Suspense>
    );
  }

  return (
    <>
      <RouteErrorBoundary view={view}>
        <Suspense fallback={<PageFallback />}>
          {view === "_design" && <DesignPreviewPage />}
          {view === "sessions" && (
            <SessionsPage
              view={view}
              onNavigate={onNavigate}
              readOnly={readOnly}
              onToast={showToast}
              daemonStatus={daemonStatus}
              initialSelectedId={subId}
              onSelectedChange={setSubId}
              initialTab={tab}
              onTabChange={setTab}
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
            <ComputePage
              view={view}
              onNavigate={onNavigate}
              readOnly={readOnly}
              daemonStatus={daemonStatus}
              initialSelectedId={subId}
              onSelectedChange={setSubId}
              onToast={showToast}
            />
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
          {view === "integrations" && (
            <IntegrationsPage
              view={view}
              onNavigate={onNavigate}
              readOnly={readOnly}
              daemonStatus={daemonStatus}
              initialTab={subId}
              onTabChange={setSubId}
            />
          )}
          {view === "settings" && (
            <SettingsPage view={view} onNavigate={onNavigate} readOnly={readOnly} daemonStatus={daemonStatus} />
          )}
        </Suspense>
      </RouteErrorBoundary>
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
  <TransportProvider transport={new HttpTransport()}>
    <QueryClientProvider client={queryClient}>
      <AppModeProvider>
        <ThemeProvider defaultTheme="midnight-circuit">
          <App />
        </ThemeProvider>
      </AppModeProvider>
    </QueryClientProvider>
  </TransportProvider>,
);
