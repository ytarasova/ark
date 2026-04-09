import { Layout } from "../components/Layout.js";
import { SettingsView } from "../components/SettingsView.js";

interface SettingsPageProps {
  view: string;
  onNavigate: (view: string) => void;
  readOnly: boolean;
}

export function SettingsPage({ view, onNavigate, readOnly }: SettingsPageProps) {
  return (
    <Layout view={view} onNavigate={onNavigate} readOnly={readOnly} title="Settings">
      <SettingsView />
    </Layout>
  );
}
