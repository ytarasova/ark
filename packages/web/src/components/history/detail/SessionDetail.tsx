import { relTime } from "../../../util.js";
import { Badge } from "../../ui/badge.js";
import { Button } from "../../ui/button.js";
import { StatusBadge, StatusDot } from "../../StatusDot.js";

interface RecentSessionDetailProps {
  selected: any;
  onSelectSession?: (id: string) => void;
}

/** Detail for a recent Ark session (non-search path). */
export function RecentSessionDetail({ selected, onSelectSession }: RecentSessionDetailProps) {
  return (
    <div className="p-5">
      <div className="flex items-center gap-2.5 mb-4">
        <StatusDot status={selected.status} />
        <h2 className="text-lg font-semibold text-foreground">{selected.summary || selected.id}</h2>
        <StatusBadge status={selected.status} />
      </div>
      <div className="mb-4">
        <h3 className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground mb-2">Details</h3>
        <div className="grid grid-cols-[120px_1fr] gap-y-1.5 gap-x-3 text-[13px]">
          <span className="text-muted-foreground">ID</span>
          <span className="text-card-foreground font-mono">{selected.id}</span>
          {selected.repo && (
            <>
              <span className="text-muted-foreground">Repository</span>
              <span className="text-card-foreground font-mono">{selected.repo}</span>
            </>
          )}
          {selected.agent && (
            <>
              <span className="text-muted-foreground">Agent</span>
              <span className="text-card-foreground">{selected.agent}</span>
            </>
          )}
          {selected.flow && (
            <>
              <span className="text-muted-foreground">Flow</span>
              <span className="text-card-foreground">{selected.flow}</span>
            </>
          )}
          {selected.updated_at && (
            <>
              <span className="text-muted-foreground">Updated</span>
              <span className="text-card-foreground font-mono">{relTime(selected.updated_at)}</span>
            </>
          )}
        </div>
      </div>
      {onSelectSession && (
        <Button size="sm" variant="outline" onClick={() => onSelectSession(selected.id)}>
          View in Sessions
        </Button>
      )}
    </div>
  );
}

interface SearchSessionDetailProps {
  selected: any;
  onSelectSession?: (id: string) => void;
}

/** Detail for a session hit from the search API. */
export function SearchSessionDetail({ selected, onSelectSession }: SearchSessionDetailProps) {
  return (
    <div className="p-5">
      <div className="flex items-center gap-2 mb-4">
        <Badge variant="outline" className="text-[10px]">
          {selected.source || "session"}
        </Badge>
        <span className="text-[12px] text-muted-foreground font-mono">{selected.sessionId || ""}</span>
        {selected.timestamp && (
          <span className="text-[11px] text-muted-foreground/60 font-mono">{relTime(selected.timestamp)}</span>
        )}
      </div>
      {selected.match && (
        <div className="mb-4">
          <h3 className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground mb-2">Match</h3>
          <div className="bg-[var(--bg-code)] border border-border rounded-lg p-3.5 text-[13px] leading-[1.7] max-h-[400px] overflow-y-auto whitespace-pre-wrap break-words text-foreground">
            {String(selected.match)}
          </div>
        </div>
      )}
      {onSelectSession && selected.sessionId && (
        <Button size="sm" variant="outline" onClick={() => onSelectSession(selected.sessionId)}>
          View in Sessions
        </Button>
      )}
    </div>
  );
}
