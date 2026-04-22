import { useState } from "react";
import { Plus } from "lucide-react";
import { Layout } from "../components/Layout.js";
import { PageShell } from "../components/PageShell.js";
import { ComputeView } from "../components/ComputeView.js";
import { Button } from "../components/ui/button.js";
import type { DaemonStatus } from "../hooks/useDaemonStatus.js";

interface ComputePageProps {
  view: string;
  onNavigate: (view: string) => void;
  readOnly: boolean;
  daemonStatus?: DaemonStatus | null;
  initialSelectedId?: string | null;
  onSelectedChange?: (id: string | null) => void;
  onToast?: (msg: string, type: string) => void;
}

export function ComputePage({
  view,
  onNavigate,
  readOnly,
  daemonStatus,
  initialSelectedId,
  onSelectedChange,
  onToast,
}: ComputePageProps) {
  const [showNew, setShowNew] = useState(false);

  return (
    <Layout view={view} onNavigate={onNavigate} readOnly={readOnly} daemonStatus={daemonStatus}>
      <PageShell
        title="Compute"
        padded={false}
        headerRight={
          !readOnly ? (
            <Button size="sm" onClick={() => setShowNew(true)}>
              <Plus size={14} />
              New Compute
            </Button>
          ) : undefined
        }
      >
        <ComputeView
          showCreate={showNew}
          onCloseCreate={() => setShowNew(false)}
          onNavigate={onNavigate}
          initialSelectedName={initialSelectedId}
          onSelectedChange={onSelectedChange}
          onToast={onToast}
        />
      </PageShell>
    </Layout>
  );
}
