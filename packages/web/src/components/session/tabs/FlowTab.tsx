import { FlowDag, stagesToFlowDagNodes } from "../../ui/FlowDag.js";
import type { StageProgress } from "../../ui/StageProgressBar.js";

interface FlowTabProps {
  session: any;
  stages: StageProgress[];
}

/**
 * Flow tab -- renders a horizontal DAG of stages for this session per the
 * `flow-dag.html` spec. Uses the FlowDag atom; the session's own flow name
 * and id drive the header.
 */
export function FlowTab({ session, stages }: FlowTabProps) {
  if (!stages || stages.length === 0) {
    return (
      <div className="text-center py-12 text-[var(--fg-faint)] font-[family-name:var(--font-mono-ui)] text-[11px] uppercase tracking-[0.05em]">
        No flow stages for this session
      </div>
    );
  }
  const nodes = stagesToFlowDagNodes(stages);
  return (
    <div className="max-w-[1100px] mx-auto">
      <FlowDag name={session?.flow || "flow"} sessionId={session?.id} nodes={nodes} />
    </div>
  );
}
