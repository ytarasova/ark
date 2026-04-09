import { useState } from "react";
import { Layout } from "../components/Layout.js";
import { FlowsView } from "../components/FlowsView.js";
import { Button } from "../components/ui/button.js";

interface FlowsPageProps {
  view: string;
  onNavigate: (view: string) => void;
  readOnly: boolean;
}

export function FlowsPage({ view, onNavigate, readOnly }: FlowsPageProps) {
  const [showNew, setShowNew] = useState(false);

  return (
    <Layout view={view} onNavigate={onNavigate} readOnly={readOnly} title="Flows" padded={false}
      headerRight={!readOnly ? <Button size="sm" onClick={() => setShowNew(true)}>+ New Flow</Button> : undefined}>
      <FlowsView showCreate={showNew} onCloseCreate={() => setShowNew(false)} />
    </Layout>
  );
}
