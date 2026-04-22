import { cn } from "../../lib/utils.js";
import { Badge } from "../ui/badge.js";
import { Button } from "../ui/button.js";

interface AgentDetailPanelProps {
  agent: any;
  onEdit: () => void;
  onDelete: () => void;
  actionMsg: { text: string; type: string } | null;
}

export function AgentDetailPanel({ agent, onEdit, onDelete, actionMsg }: AgentDetailPanelProps) {
  return (
    <div className="p-5">
      <h2 className="text-lg font-semibold text-foreground mb-1">{agent.name}</h2>
      {agent.description && <p className="text-sm text-muted-foreground mb-5">{agent.description}</p>}
      <div className="mb-4">
        <h3 className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground mb-2">
          Configuration
        </h3>
        <div className="grid grid-cols-[120px_1fr] gap-y-1.5 gap-x-3 text-[13px]">
          <span className="text-muted-foreground">Model</span>
          <span
            className="text-card-foreground"
            style={{ fontFamily: 'var(--font-mono-ui, "Geist Mono"), "JetBrains Mono", monospace' }}
          >
            {agent.model || "-"}
          </span>
          <span className="text-muted-foreground">Max Turns</span>
          <span
            className="text-card-foreground"
            style={{
              fontFamily: 'var(--font-mono-ui, "Geist Mono"), "JetBrains Mono", monospace',
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {agent.max_turns ?? "-"}
          </span>
          <span className="text-muted-foreground">Permission</span>
          <span
            className="text-card-foreground"
            style={{ fontFamily: 'var(--font-mono-ui, "Geist Mono"), "JetBrains Mono", monospace' }}
          >
            {agent.permission_mode || "-"}
          </span>
          <span className="text-muted-foreground">Runtime</span>
          <span
            className="text-card-foreground"
            style={{ fontFamily: 'var(--font-mono-ui, "Geist Mono"), "JetBrains Mono", monospace' }}
          >
            {agent.runtime || "claude-code"}
          </span>
        </div>
      </div>
      {agent.skills && agent.skills.length > 0 && (
        <div className="mb-4">
          <h3 className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground mb-2">Skills</h3>
          <div className="flex flex-wrap gap-1.5">
            {agent.skills.map((s: string) => (
              <Badge key={s} variant="default" className="text-[11px]">
                {s}
              </Badge>
            ))}
          </div>
        </div>
      )}
      {agent.tools && agent.tools.length > 0 && (
        <div className="mb-4">
          <h3 className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground mb-2">Tools</h3>
          <div className="flex flex-wrap gap-1.5">
            {agent.tools.map((t: string) => (
              <Badge key={t} variant="secondary" className="text-[11px]">
                {t}
              </Badge>
            ))}
          </div>
        </div>
      )}
      {agent.mcp_servers && agent.mcp_servers.length > 0 && (
        <div className="mb-4">
          <h3 className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground mb-2">
            MCP Servers
          </h3>
          <div className="flex flex-wrap gap-1.5">
            {agent.mcp_servers.map((m: string) => (
              <Badge key={m} variant="secondary" className="text-[11px]">
                {m}
              </Badge>
            ))}
          </div>
        </div>
      )}
      {agent.system_prompt && (
        <div className="mb-4">
          <h3 className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground mb-2">
            System Prompt
          </h3>
          <div className="bg-[var(--bg-code)] border border-border rounded-lg p-3.5 font-mono text-[11px] leading-[1.7] max-h-[300px] overflow-y-auto whitespace-pre-wrap break-all text-muted-foreground">
            {agent.system_prompt}
          </div>
        </div>
      )}
      {agent._source !== "builtin" && (
        <div className="mt-5 flex gap-1.5">
          <Button variant="outline" size="xs" onClick={onEdit}>
            Edit Agent
          </Button>
          <Button variant="destructive" size="xs" onClick={onDelete}>
            Delete Agent
          </Button>
        </div>
      )}
      {actionMsg && (
        <div
          className={cn(
            "mt-1.5 text-xs",
            actionMsg.type === "error" ? "text-[var(--failed)]" : "text-[var(--running)]",
          )}
        >
          {actionMsg.text}
        </div>
      )}
    </div>
  );
}
