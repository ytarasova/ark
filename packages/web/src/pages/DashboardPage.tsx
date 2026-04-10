import { Layout } from "../components/Layout.js";
import { DashboardView } from "../components/DashboardView.js";

interface DashboardPageProps {
  view: string;
  onNavigate: (view: string) => void;
  readOnly: boolean;
}

export function DashboardPage({ view, onNavigate, readOnly }: DashboardPageProps) {
  return (
    <Layout view={view} onNavigate={onNavigate} readOnly={readOnly} title="Dashboard" padded={false}>
      <DashboardView onNavigate={onNavigate} readOnly={readOnly} />
    </Layout>
  );
}
