import { Layout } from "../components/Layout.js";
import { PageShell } from "../components/PageShell.js";
import { SettingsView } from "../components/SettingsView.js";
import type { DaemonStatus } from "../hooks/useDaemonStatus.js";

interface SettingsPageProps {
  view: string;
  onNavigate: (view: string) => void;
  readOnly: boolean;
  daemonStatus?: DaemonStatus | null;
}

export function SettingsPage({ view, onNavigate, readOnly, daemonStatus }: SettingsPageProps) {
  return (
    <Layout view={view} onNavigate={onNavigate} readOnly={readOnly} daemonStatus={daemonStatus}>
      <PageShell title="Settings">
        <SettingsView />
      </PageShell>
    </Layout>
  );
}
