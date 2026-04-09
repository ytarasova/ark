import { useState } from "react";
import { Layout } from "../components/Layout.js";
import { AgentsView } from "../components/AgentsView.js";
import { Button } from "../components/ui/button.js";

interface AgentsPageProps {
  view: string;
  onNavigate: (view: string) => void;
  readOnly: boolean;
}

export function AgentsPage({ view, onNavigate, readOnly }: AgentsPageProps) {
  const [showNew, setShowNew] = useState(false);

  return (
    <Layout view={view} onNavigate={onNavigate} readOnly={readOnly} title="Agents" padded={false}
      headerRight={!readOnly ? <Button size="sm" onClick={() => setShowNew(true)}>+ New Agent</Button> : undefined}>
      <AgentsView showCreate={showNew} onCloseCreate={() => setShowNew(false)} />
    </Layout>
  );
}
