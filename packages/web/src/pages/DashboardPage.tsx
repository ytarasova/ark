import { Layout } from "../components/Layout.js";
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
    <Layout
      view={view}
      onNavigate={onNavigate}
      readOnly={readOnly}
      title="Dashboard"
      padded={false}
      daemonStatus={daemonStatus}
    >
      <DashboardView onNavigate={onNavigate} readOnly={readOnly} daemonStatus={daemonStatus} />
    </Layout>
  );
}
