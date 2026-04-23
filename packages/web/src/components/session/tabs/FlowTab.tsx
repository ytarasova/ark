import { FlowDag, stagesToFlowDagNodes } from "../../ui/FlowDag.js";
import { FlowTreePanel } from "../FlowTreePanel.js";
import type { StageProgress } from "../../ui/StageProgressBar.js";

interface FlowTabProps {
  session: any;
  stages: StageProgress[];
}

/**
 * Flow tab -- renders the session's stage DAG plus (when the session is a
 * root-with-children OR a child itself) a dedicated session tree panel
 * surfaced above the stage chart. Leaves with no parent + no children skip
 * the tree entirely so single-session runs stay uncluttered.
 */
export function FlowTab({ session, stages }: FlowTabProps) {
  const hasChildren = Number(session?.child_stats?.total ?? 0) > 0;
  const hasParent = session?.parent_id != null;
  const showTree = hasChildren || hasParent;

  if ((!stages || stages.length === 0) && !showTree) {
    return (
      <div className="text-center py-12 text-[var(--fg-faint)] font-[family-name:var(--font-mono-ui)] text-[11px] uppercase tracking-[0.05em]">
        No flow stages for this session
      </div>
    );
  }

  const nodes = stages && stages.length > 0 ? stagesToFlowDagNodes(stages) : [];
  return (
    <div className="max-w-[1100px] mx-auto flex flex-col gap-[12px]">
      {showTree && <FlowTreePanel session={session} />}
      {nodes.length > 0 && <FlowDag name={session?.flow || "flow"} sessionId={session?.id} nodes={nodes} />}
    </div>
  );
}
