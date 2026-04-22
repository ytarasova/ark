import { Badge } from "../ui/badge.js";
import { Separator } from "../ui/separator.js";

const GATE_VARIANT: Record<string, "success" | "warning" | "info" | "default"> = {
  auto: "success",
  manual: "warning",
  condition: "info",
  review: "default",
};

interface FlowStageListProps {
  stages: any[];
}

export function FlowStageList({ stages }: FlowStageListProps) {
  if (!stages || stages.length === 0) return null;
  return (
    <div className="mb-4">
      <h3 className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground mb-2">Stages</h3>
      <Separator className="mb-2" />
      <div className="flex flex-col gap-3">
        {stages.map((s: any, i: number) => {
          const stageName = typeof s === "string" ? s : s.name;
          const agent = typeof s === "string" ? null : s.agent;
          const gate = typeof s === "string" ? "auto" : s.gate || "auto";
          const optional = typeof s !== "string" && s.optional;
          const onFailure = typeof s !== "string" ? s.on_failure : null;
          const verify = typeof s !== "string" ? s.verify : null;
          const dependsOn = typeof s !== "string" ? s.depends_on : null;
          const action = typeof s !== "string" ? s.action : null;
          const stageType = typeof s !== "string" ? s.type : null;

          return (
            <div key={i} className="border border-border/50 rounded-lg p-3 bg-[var(--bg-code)]/50">
              <div className="flex items-center gap-2 mb-1.5">
                <span className="text-[10px] font-mono text-muted-foreground w-5">{i + 1}</span>
                <span className="text-[13px] font-semibold text-foreground">{stageName}</span>
                <Badge variant={GATE_VARIANT[gate] || "success"} className="text-[10px]">
                  {gate}
                </Badge>
                {optional && (
                  <Badge variant="info" className="text-[10px]">
                    optional
                  </Badge>
                )}
                {stageType && stageType !== "-" && (
                  <Badge variant="secondary" className="text-[10px]">
                    {stageType}
                  </Badge>
                )}
              </div>
              <div className="grid grid-cols-[80px_1fr] gap-x-2 gap-y-1 text-[11px] ml-5">
                {agent && (
                  <>
                    <span className="text-muted-foreground">Agent</span>
                    <span className="text-card-foreground font-mono">{agent}</span>
                  </>
                )}
                {action && (
                  <>
                    <span className="text-muted-foreground">Action</span>
                    <span className="text-card-foreground font-mono">{action}</span>
                  </>
                )}
                <span className="text-muted-foreground">Gate</span>
                <span className="text-card-foreground">
                  {gate === "auto" && "Automatic -- no human intervention needed"}
                  {gate === "manual" && "Manual -- requires human approval to proceed"}
                  {gate === "condition" && "Conditional -- proceeds based on expression evaluation"}
                  {gate === "review" && "Review -- waits for external review (e.g. PR approval)"}
                </span>
                {dependsOn && dependsOn.length > 0 && (
                  <>
                    <span className="text-muted-foreground">Depends on</span>
                    <span className="text-card-foreground font-mono">{dependsOn.join(", ")}</span>
                  </>
                )}
                {onFailure && (
                  <>
                    <span className="text-muted-foreground">On failure</span>
                    <span className="text-[var(--waiting)] font-mono">{onFailure}</span>
                  </>
                )}
                {verify && verify.length > 0 && (
                  <>
                    <span className="text-muted-foreground">Verify</span>
                    <span className="text-card-foreground font-mono">{verify.join(", ")}</span>
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
