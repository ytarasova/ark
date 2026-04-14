import { useState } from "react";
import { Layout } from "../components/Layout.js";
import { MemoryView } from "../components/MemoryView.js";
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
    <Layout view={view} onNavigate={onNavigate} readOnly={readOnly} title="Memory" padded={false} daemonStatus={daemonStatus}
      headerRight={!readOnly ? <Button size="sm" onClick={() => setAddCounter(c => c + 1)}>+ Add Memory</Button> : undefined}>
      <MemoryView addRequested={addCounter} onToast={onToast} />
    </Layout>
  );
}
