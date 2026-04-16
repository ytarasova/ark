import { Layout } from "../components/Layout.js";
import { BurnView } from "../components/burn/BurnView.js";
import type { DaemonStatus } from "../hooks/useDaemonStatus.js";

interface BurnPageProps {
  view: string;
  onNavigate: (view: string) => void;
  readOnly: boolean;
  daemonStatus?: DaemonStatus | null;
}

export function BurnPage({ view, onNavigate, readOnly, daemonStatus }: BurnPageProps) {
  return (
    <Layout view={view} onNavigate={onNavigate} readOnly={readOnly} title="CodeBurn (local)" padded={false} daemonStatus={daemonStatus}>
      <BurnView />
    </Layout>
  );
}
