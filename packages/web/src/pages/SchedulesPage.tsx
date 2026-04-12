import { useState } from "react";
import { Layout } from "../components/Layout.js";
import { ScheduleView } from "../components/ScheduleView.js";
import { Button } from "../components/ui/button.js";
import type { DaemonStatus } from "../hooks/useDaemonStatus.js";

interface SchedulesPageProps {
  view: string;
  onNavigate: (view: string) => void;
  readOnly: boolean;
  daemonStatus?: DaemonStatus | null;
}

export function SchedulesPage({ view, onNavigate, readOnly, daemonStatus }: SchedulesPageProps) {
  const [showNew, setShowNew] = useState(false);

  return (
    <Layout view={view} onNavigate={onNavigate} readOnly={readOnly} title="Schedules" padded={false} daemonStatus={daemonStatus}
      headerRight={!readOnly ? <Button size="sm" onClick={() => setShowNew(true)}>+ New Schedule</Button> : undefined}>
      <ScheduleView showCreate={showNew} onCloseCreate={() => setShowNew(false)} />
    </Layout>
  );
}
