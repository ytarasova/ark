import { Layout } from "../components/Layout.js";
import { PageShell } from "../components/PageShell.js";
import { DashboardView } from "../components/DashboardView.js";
import type { DaemonStatus } from "../hooks/useDaemonStatus.js";

interface DashboardPageProps {
  view: string;
  onNavigate: (view: string) => void;
  readOnly: boolean;
  daemonStatus?: DaemonStatus | null;
}

export function DashboardPage({ view, onNavigate, readOnly, daemonStatus }: DashboardPageProps) {
  return (
    <Layout view={view} onNavigate={onNavigate} readOnly={readOnly} daemonStatus={daemonStatus}>
      <PageShell title="Dashboard" padded={false}>
        <DashboardView onNavigate={onNavigate} readOnly={readOnly} daemonStatus={daemonStatus} />
      </PageShell>
    </Layout>
  );
}
