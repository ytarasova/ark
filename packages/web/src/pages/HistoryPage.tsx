import { useState } from "react";
import { Layout } from "../components/Layout.js";
import { PageShell } from "../components/PageShell.js";
import { HistoryView } from "../components/HistoryView.js";
import { cn } from "../lib/utils.js";
import { Database, FileText } from "lucide-react";
import type { DaemonStatus } from "../hooks/useDaemonStatus.js";

interface HistoryPageProps {
  view: string;
  onNavigate: (view: string) => void;
  readOnly: boolean;
  daemonStatus?: DaemonStatus | null;
}

export function HistoryPage({ view, onNavigate, readOnly, daemonStatus }: HistoryPageProps) {
  const [historyMode, setHistoryMode] = useState<"sessions" | "transcripts">("sessions");

  return (
    <Layout view={view} onNavigate={onNavigate} readOnly={readOnly} daemonStatus={daemonStatus}>
      <PageShell
        title="History"
        padded={false}
        headerLeft={
          <div className="flex gap-1 ml-2">
            {(["sessions", "transcripts"] as const).map((m) => (
              <button
                key={m}
                onClick={() => setHistoryMode(m)}
                className={cn(
                  "px-3 py-1 text-[12px] font-medium rounded-md inline-flex items-center gap-1.5",
                  "transition-colors duration-150 ease-[cubic-bezier(0.32,0.72,0,1)]",
                  historyMode === m ? "bg-secondary text-foreground" : "text-muted-foreground hover:text-foreground",
                )}
              >
                {m === "sessions" ? <Database size={12} /> : <FileText size={12} />}
                {m.charAt(0).toUpperCase() + m.slice(1)}
              </button>
            ))}
          </div>
        }
      >
        <HistoryView mode={historyMode} onModeChange={setHistoryMode} onSelectSession={() => onNavigate("sessions")} />
      </PageShell>
    </Layout>
  );
}
