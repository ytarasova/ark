import { useState } from "react";
import { Layout } from "../components/Layout.js";
import { HistoryView } from "../components/HistoryView.js";
import { cn } from "../lib/utils.js";
import { Database, FileText } from "lucide-react";

interface HistoryPageProps {
  view: string;
  onNavigate: (view: string) => void;
  readOnly: boolean;
}

export function HistoryPage({ view, onNavigate, readOnly }: HistoryPageProps) {
  const [historyMode, setHistoryMode] = useState<"sessions" | "transcripts">("sessions");

  return (
    <Layout view={view} onNavigate={onNavigate} readOnly={readOnly} title="History" padded={false}
      headerLeft={
        <div className="flex gap-1 ml-2">
          {(["sessions", "transcripts"] as const).map(m => (
            <button key={m} onClick={() => setHistoryMode(m)} className={cn(
              "px-3 py-1 text-xs font-medium rounded-md transition-colors inline-flex items-center gap-1.5",
              historyMode === m ? "bg-secondary text-foreground" : "text-muted-foreground hover:text-foreground"
            )}>
              {m === "sessions" ? <Database size={12} /> : <FileText size={12} />}
              {m.charAt(0).toUpperCase() + m.slice(1)}
            </button>
          ))}
        </div>
      }>
      <HistoryView mode={historyMode} onModeChange={setHistoryMode} onSelectSession={() => onNavigate("sessions")} />
    </Layout>
  );
}
