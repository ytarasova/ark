import { useState } from "react";
import { Layout } from "../components/Layout.js";
import { PageShell } from "../components/PageShell.js";
import { MemoryView } from "../components/MemoryView.js";
import { CodebaseMemoryPanel } from "../components/CodebaseMemoryPanel.js";
import { Button } from "../components/ui/button.js";
import type { DaemonStatus } from "../hooks/useDaemonStatus.js";

interface MemoryPageProps {
  view: string;
  onNavigate: (view: string) => void;
  readOnly: boolean;
  daemonStatus?: DaemonStatus | null;
  onToast?: (msg: string, type: string) => void;
}

export function MemoryPage({ view, onNavigate, readOnly, daemonStatus, onToast }: MemoryPageProps) {
  const [addCounter, setAddCounter] = useState(0);

  return (
    <Layout view={view} onNavigate={onNavigate} readOnly={readOnly} daemonStatus={daemonStatus}>
      <PageShell
        title="Memory"
        padded={false}
        headerRight={
          !readOnly ? (
            <Button size="sm" onClick={() => setAddCounter((c) => c + 1)}>
              + Add Memory
            </Button>
          ) : undefined
        }
      >
        <div className="p-4 space-y-4">
          <CodebaseMemoryPanel />
          <MemoryView addRequested={addCounter} onToast={onToast} />
        </div>
      </PageShell>
    </Layout>
  );
}
