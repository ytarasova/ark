import { useCallback, useState } from "react";
import { Layout } from "../components/Layout.js";
import { PageShell } from "../components/PageShell.js";
import { AgentsView } from "../components/AgentsView.js";
import type { AgentsSubTab } from "../components/agents/SubTabBar.js";
import { Button } from "../components/ui/button.js";
import type { DaemonStatus } from "../hooks/useDaemonStatus.js";

interface AgentsPageProps {
  view: string;
  onNavigate: (view: string) => void;
  readOnly: boolean;
  daemonStatus?: DaemonStatus | null;
  initialSelectedId?: string | null;
  onSelectedChange?: (id: string | null) => void;
  tab?: string | null;
  onTabChange?: (tab: string | null) => void;
}

export function AgentsPage({
  view,
  onNavigate,
  readOnly,
  daemonStatus,
  initialSelectedId,
  onSelectedChange,
  tab,
  onTabChange,
}: AgentsPageProps) {
  const [showNew, setShowNew] = useState(false);

  const subTab: AgentsSubTab = tab === "runtimes" ? "runtimes" : "roles";
  const handleSubTabChange = useCallback(
    (next: AgentsSubTab) => {
      onTabChange?.(next === "roles" ? null : next);
    },
    [onTabChange],
  );

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
          subTab={subTab}
          onSubTabChange={handleSubTabChange}
        />
      </PageShell>
    </Layout>
  );
}
