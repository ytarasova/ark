import { Layout } from "../components/Layout.js";
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
    <Layout
      view={view}
      onNavigate={onNavigate}
      readOnly={readOnly}
      title="Costs"
      padded={false}
      daemonStatus={daemonStatus}
    >
      <CostsView />
    </Layout>
  );
}
