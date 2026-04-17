import { useState } from "react";
import { Layout } from "../components/Layout.js";
import { PageShell } from "../components/PageShell.js";
import { AgentsView } from "../components/AgentsView.js";
import { Button } from "../components/ui/button.js";
import type { DaemonStatus } from "../hooks/useDaemonStatus.js";

interface AgentsPageProps {
  view: string;
  onNavigate: (view: string) => void;
  readOnly: boolean;
  daemonStatus?: DaemonStatus | null;
  initialSelectedId?: string | null;
  onSelectedChange?: (id: string | null) => void;
}

export function AgentsPage({
  view,
  onNavigate,
  readOnly,
  daemonStatus,
  initialSelectedId,
  onSelectedChange,
}: AgentsPageProps) {
  const [showNew, setShowNew] = useState(false);

  return (
    <Layout view={view} onNavigate={onNavigate} readOnly={readOnly} daemonStatus={daemonStatus}>
      <PageShell
        title="Agents"
        padded={false}
        headerRight={
          !readOnly ? (
            <Button size="sm" onClick={() => setShowNew(true)}>
              + New Agent
            </Button>
          ) : undefined
        }
      >
        <AgentsView
          showCreate={showNew}
          onCloseCreate={() => setShowNew(false)}
          initialSelectedName={initialSelectedId}
          onSelectedChange={onSelectedChange}
        />
      </PageShell>
    </Layout>
  );
}
