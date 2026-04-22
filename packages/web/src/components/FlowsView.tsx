import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { GitBranch } from "lucide-react";
import { api } from "../hooks/useApi.js";
import { useAgentsQuery } from "../hooks/useAgentQueries.js";
import { useFlowDetail, useFlowsQuery } from "../hooks/useFlowQueries.js";
import { cn } from "../lib/utils.js";
import { FlowForm } from "./flows/FlowForm.js";
import { FlowStageList } from "./flows/FlowStageList.js";
import { flowEdgesToPipeline, flowStagesToPipeline } from "./flows/pipeline/adapters.js";
import { PipelineViewer } from "./pipeline/PipelineViewer.js";
import { Badge } from "./ui/badge.js";
import { Button } from "./ui/button.js";

interface FlowsViewProps {
  showCreate?: boolean;
  onCloseCreate?: () => void;
  initialSelectedName?: string | null;
  onSelectedChange?: (name: string | null) => void;
}

/** DAG visualization for a flow definition using PipelineViewer. */
function FlowDAG({ selected }: { selected: any }) {
  const pipelineStages = useMemo(() => flowStagesToPipeline(selected.stages), [selected.stages]);
  const pipelineEdges = useMemo(
    () => flowEdgesToPipeline(selected.stages, selected.edges),
    [selected.stages, selected.edges],
  );

  if (!selected.stages || selected.stages.length === 0) return null;

  return (
    <div className="mb-5">
      <PipelineViewer stages={pipelineStages} edges={pipelineEdges} currentStage={null} flowName={selected.name} />
    </div>
  );
}

export function FlowsView({
  showCreate = false,
  onCloseCreate,
  initialSelectedName,
  onSelectedChange,
}: FlowsViewProps) {
  const queryClient = useQueryClient();
  const { data: flows = [] } = useFlowsQuery();
  const { data: agents = [] } = useAgentsQuery();
  const [selectedName, setSelectedNameInternal] = useState<string | null>(initialSelectedName ?? null);
  const setSelectedName = (name: string | null) => {
    setSelectedNameInternal(name);
    onSelectedChange?.(name);
  };
  const { data: selectedDetail } = useFlowDetail(selectedName);
  const selected = selectedDetail || (selectedName ? flows.find((f: any) => f.name === selectedName) : null);
  const [actionMsg, setActionMsg] = useState<{ text: string; type: string } | null>(null);

  function showActionMsg(text: string, type: string) {
    setActionMsg({ text, type });
    setTimeout(() => setActionMsg(null), 3000);
  }

  async function handleCreate(form: any) {
    try {
      await api.createFlow(form);
      onCloseCreate?.();
      queryClient.invalidateQueries({ queryKey: ["flows"] });
    } catch (err: any) {
      showActionMsg(err.message || "Failed to create flow", "error");
    }
  }

  async function handleDelete(name: string) {
    try {
      await api.deleteFlow(name);
      setSelectedName(null);
      queryClient.invalidateQueries({ queryKey: ["flows"] });
    } catch (err: any) {
      showActionMsg(err.message || "Failed to delete flow", "error");
    }
  }

  if (!flows.length && !showCreate) {
    return (
      <div className="flex items-center justify-center h-[calc(100vh-180px)]">
        <div className="text-center">
          <GitBranch size={28} className="text-muted-foreground/40 mx-auto mb-3" />
          <p className="text-sm text-muted-foreground">No flows found</p>
        </div>
      </div>
    );
  }

  const listEntry = selected ? flows.find((f: any) => f.name === selected.name) : null;
  const selectedSource = selected ? selected.source || listEntry?.source : null;

  return (
    <div className="grid grid-cols-[260px_1fr] overflow-hidden h-full">
      <div className="border-r border-border overflow-y-auto" role="listbox" aria-label="Flows">
        {flows.map((f: any) => {
          const stageCount = f.stages?.length ?? 0;
          return (
            <div
              key={f.name}
              className={cn(
                "flex items-center justify-between px-4 py-2.5 cursor-pointer border-b border-border/50 transition-colors text-[13px]",
                "hover:bg-accent",
                selected?.name === f.name && "bg-accent border-l-2 border-l-primary font-semibold",
              )}
              onClick={() => setSelectedName(f.name)}
            >
              <span className="text-foreground truncate">{f.name}</span>
              <Badge variant="secondary" className="text-[10px]">
                {stageCount} stage{stageCount !== 1 ? "s" : ""}
              </Badge>
            </div>
          );
        })}
      </div>
      <div className="overflow-y-auto bg-background">
        {showCreate ? (
          <FlowForm onClose={() => onCloseCreate?.()} onSubmit={handleCreate} agents={agents} />
        ) : selected ? (
          <div className="p-5">
            <h2 className="text-lg font-semibold text-foreground mb-1">{selected.name}</h2>
            {selected.description && <p className="text-sm text-muted-foreground mb-5">{selected.description}</p>}

            <FlowDAG selected={selected} />

            <FlowStageList stages={selected.stages} />

            {selectedSource && selectedSource !== "builtin" && (
              <div className="mt-5 flex gap-1.5">
                <Button variant="destructive" size="xs" onClick={() => handleDelete(selected.name)}>
                  Delete Flow
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
        ) : (
          <div className="flex items-center justify-center h-full text-sm text-muted-foreground">Select a flow</div>
        )}
      </div>
    </div>
  );
}
