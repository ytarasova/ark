import { Layout } from "../components/Layout.js";
import { PageShell } from "../components/PageShell.js";
import { CostsView } from "../components/CostsView.js";
import type { DaemonStatus } from "../hooks/useDaemonStatus.js";

interface CostsPageProps {
  view: string;
  onNavigate: (view: string) => void;
  readOnly: boolean;
  daemonStatus?: DaemonStatus | null;
}

export function CostsPage({ view, onNavigate, readOnly, daemonStatus }: CostsPageProps) {
  return (
    <Layout view={view} onNavigate={onNavigate} readOnly={readOnly} daemonStatus={daemonStatus}>
      <PageShell title="Costs" padded={false}>
        <CostsView />
      </PageShell>
    </Layout>
  );
}
