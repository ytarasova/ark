import "./styles.css";
import { useState, useCallback } from "react";
import { createRoot } from "react-dom/client";
import { queryClient, QueryClientProvider } from "./providers/QueryProvider.js";
import { Toast } from "./components/Toast.js";
import { SessionsPage } from "./pages/SessionsPage.js";
import { ToolsPage } from "./pages/ToolsPage.js";
import { AgentsPage } from "./pages/AgentsPage.js";
import { FlowsPage } from "./pages/FlowsPage.js";
import { HistoryPage } from "./pages/HistoryPage.js";
import { ComputePage } from "./pages/ComputePage.js";
import { SchedulesPage } from "./pages/SchedulesPage.js";
import { MemoryPage } from "./pages/MemoryPage.js";
import { CostsPage } from "./pages/CostsPage.js";
import { BurnPage } from "./pages/BurnPage.js";
import { SettingsPage } from "./pages/SettingsPage.js";
import { LoginPage } from "./pages/LoginPage.js";
import { DashboardPage } from "./pages/DashboardPage.js";
import { useDaemonStatus } from "./hooks/useDaemonStatus.js";
import { useHashRouter } from "./hooks/useHashRouter.js";

const READ_ONLY = document.getElementById("root")?.dataset.readonly === "true";
const AUTH_REQUIRED = document.getElementById("root")?.dataset.auth === "true";

function App() {
  const { view, subId, navigate, setSubId } = useHashRouter();
  const [toast, setToast] = useState<{ msg: string; type: string } | null>(null);
  const [toastKey, setToastKey] = useState(0);
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

  if (!authenticated) {
    return <LoginPage onLogin={() => setAuthenticated(true)} />;
  }

  return (
    <>
      {view === "dashboard" && (
        <DashboardPage view={view} onNavigate={onNavigate} readOnly={readOnly} daemonStatus={daemonStatus} />
      )}
      {view === "sessions" && (
        <SessionsPage view={view} onNavigate={onNavigate} readOnly={readOnly} onToast={showToast} daemonStatus={daemonStatus} initialSelectedId={subId} onSelectedChange={setSubId} />
      )}
      {view === "agents" && (
        <AgentsPage view={view} onNavigate={onNavigate} readOnly={readOnly} daemonStatus={daemonStatus} initialSelectedId={subId} onSelectedChange={setSubId} />
      )}
      {view === "tools" && (
        <ToolsPage view={view} onNavigate={onNavigate} readOnly={readOnly} daemonStatus={daemonStatus} />
      )}
      {view === "flows" && (
        <FlowsPage view={view} onNavigate={onNavigate} readOnly={readOnly} daemonStatus={daemonStatus} initialSelectedId={subId} onSelectedChange={setSubId} />
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
        <MemoryPage view={view} onNavigate={onNavigate} readOnly={readOnly} daemonStatus={daemonStatus} onToast={showToast} />
      )}
      {view === "costs" && (
        <CostsPage view={view} onNavigate={onNavigate} readOnly={readOnly} daemonStatus={daemonStatus} />
      )}
      {view === "burn" && (
        <BurnPage view={view} onNavigate={onNavigate} readOnly={readOnly} daemonStatus={daemonStatus} />
      )}
      {view === "settings" && (
        <SettingsPage view={view} onNavigate={onNavigate} readOnly={readOnly} daemonStatus={daemonStatus} />
      )}
      {toast && (
        <Toast
          key={toastKey}
          message={toast.msg}
          type={toast.type}
          onDone={() => setToast(null)}
        />
      )}
    </>
  );
}

// ---- Mount ----
const root = createRoot(document.getElementById("root")!);
root.render(
  <QueryClientProvider client={queryClient}>
    <App />
  </QueryClientProvider>
);
