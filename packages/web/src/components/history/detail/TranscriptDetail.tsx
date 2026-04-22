import { relTime } from "../../../util.js";
import { Badge } from "../../ui/badge.js";
import { Button } from "../../ui/button.js";
import { TranscriptMessages } from "../TranscriptMessages.js";

interface ClaudeTranscriptDetailProps {
  cs: any;
}

/** Detail for a Claude Code session from the transcripts list. */
export function ClaudeTranscriptDetail({ cs }: ClaudeTranscriptDetailProps) {
  return (
    <div className="p-5">
      <div className="flex items-center gap-2 mb-4">
        <Badge variant="outline" className="text-[10px]">
          transcript
        </Badge>
        {cs.project && <span className="text-[13px] font-semibold text-foreground">{cs.project}</span>}
      </div>
      {cs.summary && (
        <div className="mb-4">
          <h3 className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground mb-2">Summary</h3>
          <p className="text-[13px] text-foreground leading-relaxed">{cs.summary}</p>
        </div>
      )}
      <div className="mb-4">
        <h3 className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground mb-2">Details</h3>
        <div className="grid grid-cols-[120px_1fr] gap-y-1.5 gap-x-3 text-[13px]">
          <span className="text-muted-foreground">Session ID</span>
          <span className="text-card-foreground font-mono text-[12px] break-all">{cs.sessionId}</span>
          {cs.project && (
            <>
              <span className="text-muted-foreground">Project</span>
              <span className="text-card-foreground font-mono">{cs.project}</span>
            </>
          )}
          {cs.projectDir && (
            <>
              <span className="text-muted-foreground">Directory</span>
              <span className="text-card-foreground font-mono text-[12px] break-all">{cs.projectDir}</span>
            </>
          )}
          {cs.transcriptPath && (
            <>
              <span className="text-muted-foreground">Transcript</span>
              <span className="text-card-foreground font-mono text-[11px] break-all">{cs.transcriptPath}</span>
            </>
          )}
          {cs.messageCount != null && (
            <>
              <span className="text-muted-foreground">Messages</span>
              <span className="text-card-foreground">{cs.messageCount}</span>
            </>
          )}
          {(cs.lastActivity || cs.timestamp) && (
            <>
              <span className="text-muted-foreground">Last Activity</span>
              <span className="text-card-foreground font-mono">{relTime(cs.lastActivity || cs.timestamp)}</span>
            </>
          )}
          {cs.timestamp && (
            <>
              <span className="text-muted-foreground">Created</span>
              <span className="text-card-foreground font-mono">{relTime(cs.timestamp)}</span>
            </>
          )}
        </div>
      </div>
      <TranscriptMessages sessionId={cs.sessionId || cs.session_id} />
    </div>
  );
}

interface SearchTranscriptDetailProps {
  r: any;
  onSelectSession?: (id: string) => void;
}

/** Detail for a transcript hit from the global search. */
export function SearchTranscriptDetail({ r, onSelectSession }: SearchTranscriptDetailProps) {
  return (
    <div className="p-5">
      <div className="flex items-center gap-2 mb-4">
        <Badge variant="outline" className="text-[10px]">
          transcript
        </Badge>
        {r.projectName && <span className="text-[12px] text-muted-foreground font-mono">{r.projectName}</span>}
        {r.fileName && <span className="text-[12px] text-muted-foreground/60 font-mono">{r.fileName}</span>}
      </div>
      <div className="mb-4">
        <h3 className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground mb-2">Content</h3>
        <div className="bg-[var(--bg-code)] border border-border rounded-lg p-3.5 text-[13px] leading-[1.7] max-h-[400px] overflow-y-auto whitespace-pre-wrap break-words text-foreground">
          {r.matchLine || r.match || String(r.content || "")}
        </div>
      </div>
      {r.lineNumber && <div className="text-[10px] text-muted-foreground/50 font-mono">line {r.lineNumber}</div>}
      {onSelectSession && r.sessionId && (
        <Button size="sm" variant="outline" className="mt-3" onClick={() => onSelectSession(r.sessionId)}>
          View in Sessions
        </Button>
      )}
    </div>
  );
}
