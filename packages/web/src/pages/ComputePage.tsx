import { useState } from "react";
import { Layout } from "../components/Layout.js";
import { ComputeView } from "../components/ComputeView.js";
import { Button } from "../components/ui/button.js";

interface ComputePageProps {
  view: string;
  onNavigate: (view: string) => void;
  readOnly: boolean;
}

export function ComputePage({ view, onNavigate, readOnly }: ComputePageProps) {
  const [showNew, setShowNew] = useState(false);

  return (
    <Layout view={view} onNavigate={onNavigate} readOnly={readOnly} title="Compute" padded={false}
      headerRight={!readOnly ? <Button size="sm" onClick={() => setShowNew(true)}>+ New Compute</Button> : undefined}>
      <ComputeView showCreate={showNew} onCloseCreate={() => setShowNew(false)} />
    </Layout>
  );
}
